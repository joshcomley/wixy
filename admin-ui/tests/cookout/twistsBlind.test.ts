import { afterEach, describe, expect, it } from "vitest";
import { LENTILS, P1_PICKS, P2_PICKS } from "./fixtures";
import {
  DURIAN,
  NATTO,
  TOMATOES,
  earlierSet,
  gated,
  makeHarness,
  pick,
  q,
  qa,
  readyVote,
  setup,
  stars,
  swap,
  twistFinished,
  twistPicking,
  type Harness,
  type Json,
} from "./twistFixtures";

// BLIND DOM LEAK TESTS (spec/server-chat/09a-cookout-twists.md §8, §6 privacy): Player 1's pane in a Blind
// round must hold nothing of Player 2's before the reveal — not their picks, their chaos-shelf pair, their
// secret star or their dinner vote — whether the server filters correctly or (a buggy one) sends it all.
// The stars and the dinner vote stay secret from the partner in BOTH modes until their own reveal.

afterEach(() => document.body.replaceChildren());

/** Everything that is Player 2's (and not Player 1's own table) in these fixtures. */
const PARTNER_THINGS: readonly Json[] = [...P2_PICKS, DURIAN, NATTO];
const PARTNER_STAR = "dark-brown-sugar";

function expectNoPartnerStrings(pane: HTMLElement, label: string): void {
  const html = pane.outerHTML;
  for (const thing of PARTNER_THINGS) {
    expect(html, `${label}: ${thing["name"] as string}`).not.toContain(thing["name"] as string);
    expect(html, `${label}: ${thing["id"] as string}`).not.toContain(thing["id"] as string);
  }
}

/** A Blind round at `turn`, as a LEAKING server would send it to Player 1: every partner secret included. */
function leaking(turn: number): Json {
  const mine = turn % 2 === 1;
  const p1n = Math.floor(turn / 2);
  const p2n = Math.floor((turn - 1) / 2);
  const p2Leak = P2_PICKS.slice(0, p2n).map((s, i) => pick(s, 2 * i + 2));
  return twistPicking(
    {
      blind: true,
      you: 1,
      turn,
      // Their own pair on their own turns; the partner's chaos pair on the partner's.
      options: mine ? [TOMATOES, LENTILS] : [DURIAN, NATTO],
      p1Picks: P1_PICKS.slice(0, p1n).map((s, i) => pick(s, 2 * i + 1)),
      p2Picks: p2Leak,
    },
    {
      players: [
        { slot: 1, name: "Josh", pickCount: p1n, picks: P1_PICKS.slice(0, p1n).map((s, i) => pick(s, 2 * i + 1)), chaosUsed: false, vetoUsed: false },
        { slot: 2, name: "Cupcake", pickCount: p2n, picks: p2Leak, chaosUsed: true, vetoUsed: true },
      ],
      you: { slot: 1, chaosUsed: false, vetoUsed: false },
      basket: [...P1_PICKS.slice(0, p1n), ...P2_PICKS.slice(0, p2n)].map((s) => pick(s, null)),
      stars: stars({ mine: null, partnerChosen: true, revealed: false, partner: PARTNER_STAR }),
      history: P2_PICKS.slice(0, p2n).map((s, i) => ({
        turn: 2 * i + 2,
        player: 2,
        offers: [[s, DURIAN]],
        choice: s,
        seed: null,
        replaced: [{ offer: 0, snap: NATTO, by: "chaos" }],
        chaosOffer: 0,
        lucky: true,
      })),
    },
    mine
      ? { canChaos: true, canLucky: true, canVeto: true }
      : { chaosPair: true, vetoed: { snap: NATTO }, canChaos: true, canLucky: true, canVeto: true, role: "protein", offerIndex: 0, skipsRemaining: 2 },
  );
}

describe("Blind picking: nothing of the partner's, whatever the server sends", () => {
  it("a correctly filtered view has none of the partner's strings, only counted secrets", () => {
    const h = makeHarness();
    h.show(twistPicking({ blind: true, you: 1, turn: 4, showOptions: false, p2Picks: null, p2Count: 1 }, { stars: stars({ partnerChosen: false }) }));
    expectNoPartnerStrings(h.pane, "server-filtered");
    expect(qa(h.pane, ".wx-srv-ck-chip-secret")).toHaveLength(1);
    expect(h.pane.querySelector(".wx-srv-ck-chaos-note")).toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-sweep")).toBeNull();
  });

  it("a leaking view on the partner's turn shows the cloche and none of their pair, picks, chaos pair or star", () => {
    const h = makeHarness();
    h.show(leaking(4));
    expectNoPartnerStrings(h.pane, "turn 4");
    expect(q(h.pane, ".wx-srv-ck-cloche-text").textContent).toBe("🕵️ Secret turn: Cupcake is choosing…");
    expect(h.pane.querySelector(".wx-srv-ck-opt")).toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-chaos-note")).toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-opt-exotic")).toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-swept")).toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-lucky")).toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-chaos")).toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-sweep")).toBeNull();
    // Their role is a hint at their pair: not shown either.
    expect(h.pane.textContent).not.toContain("protein");
    expect(qa(h.pane, ".wx-srv-ck-chip-secret")).toHaveLength(1);
    expect(h.pane.querySelector(".wx-srv-ck-star-mark")).toBeNull();
    expect(h.pane.querySelector(".wx-srv-ck-pill-star")).toBeNull();
  });

  it("holds start to finish: every redraw of the draft, turn by turn, with the leak on", () => {
    const h = makeHarness();
    for (let turn = 1; turn <= 9; turn += 1) {
      h.show(leaking(turn));
      expectNoPartnerStrings(h.pane, `turn ${turn}`);
      // The partner's flags never produce a control for the viewer.
      expect(h.pane.querySelector(".wx-srv-ck-sweep"), `sweep at turn ${turn}`).toBeNull();
      if (turn % 2 === 0) expect(h.pane.querySelector(".wx-srv-ck-chaos-note"), `note at turn ${turn}`).toBeNull();
    }
  });

  it("the partner's chaos token is not shown: after their chaos pair, Player 1's own button is unaffected", () => {
    const h = makeHarness();
    h.show(leaking(5));
    // It is Player 1's own table now: their own buttons come from THEIR flags only.
    expect(q<HTMLButtonElement>(h.pane, ".wx-srv-ck-chaos").disabled).toBe(false);
    expectNoPartnerStrings(h.pane, "turn 5");
  });

  it("the partner's swept option never appears on Player 1's pane in Blind (veto is an Open twist)", () => {
    const h = makeHarness();
    h.show(twistPicking({ blind: true, you: 1, turn: 1 }, {}, { canVeto: true }));
    expect(h.pane.querySelector(".wx-srv-ck-sweep")).toBeNull();
    h.show(twistPicking({ blind: true, you: 2, turn: 1, showOptions: false }, {}, { canVeto: true }));
    expect(h.pane.querySelector(".wx-srv-ck-sweep")).toBeNull();
  });

  it("a non-player holds neither player's secrets", () => {
    const h = makeHarness();
    h.show({ ...leaking(4), you: null });
    expectNoPartnerStrings(h.pane, "non-player");
    for (const mineName of P1_PICKS) expect(h.pane.outerHTML).not.toContain(mineName["name"] as string);
  });
});

describe("a Blind round, finished: the picks are revealed together, the stars and the vote are not", () => {
  /** The finished stage as a leaking server sends it: the partner's star and vote both present early. */
  function finishedLeaking(vote: Json | null, starsPatch: Json = {}, o: { gate?: readonly string[] } = {}): Json {
    const root: Json = {
      setup: setup({ stars: true }),
      stars: stars({ mine: "double-espresso", partnerChosen: true, revealed: false, partner: PARTNER_STAR, ...starsPatch }),
      ...(vote === null ? {} : { vote }),
    };
    return o.gate === undefined ? twistFinished({ blind: true, concepts: "ready", images: "done" }, root) : gated(o.gate, root, { blind: true });
  }

  it("the partner's star is not marked while the stars are still secret", () => {
    const h = makeHarness();
    h.show(finishedLeaking(null, {}, { gate: ["stars"] }));
    const partnerChip = q(h.pane, `.wx-srv-ck-reveal-chip[data-picked="${PARTNER_STAR}"]`);
    // The ten picks are revealed (it is the big reveal) ...
    expect(partnerChip.textContent).toContain("Dark brown sugar");
    // ... but which one the partner starred is not.
    expect(partnerChip.classList.contains("wx-srv-ck-chip-starred")).toBe(false);
    expect(partnerChip.querySelector(".wx-srv-ck-star-mark, .wx-srv-ck-star")).toBeNull();
    expect(qa(h.pane, ".wx-srv-ck-reveal-chip.wx-srv-ck-chip-starred")).toHaveLength(1);
    expect(h.pane.querySelector(".wx-srv-ck-stars-revealed")).toBeNull();
    expect(q(h.pane, ".wx-srv-ck-gate-text").textContent).toBe("Waiting for Cupcake to star one");
  });

  it("the partner's star is not a reason to refuse a swap of it", () => {
    const h = makeHarness();
    h.show(finishedLeaking(null, {}, {}));
    h.show({ ...finishedLeaking(null), swap: swap({ available: true }) });
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-rescue").click();
    const item = q<HTMLButtonElement>(h.pane, `.wx-srv-ck-swap-item[data-ingredient="${PARTNER_STAR}"]`);
    expect(item.disabled).toBe(false);
    expect(item.querySelector(".wx-srv-ck-star-mark")).toBeNull();
    // Their own star is protected.
    expect(q<HTMLButtonElement>(h.pane, '.wx-srv-ck-swap-item[data-ingredient="double-espresso"]').disabled).toBe(true);
  });

  it("the partner's dinner vote is not shown before both votes are in (no badge, no crown, no pressed state)", () => {
    for (const leakedVote of [
      readyVote({ you: "a", partnerVoted: true, revealed: false, votes: { "1": "a", "2": "c" }, match: null }),
      // Even a forged match must not crown anything.
      readyVote({ you: "a", partnerVoted: true, revealed: false, votes: { "1": "a", "2": "a" }, match: "a" }),
      // ... and neither does a "revealed" flag with a one-sided vote.
      readyVote({ you: "a", partnerVoted: true, revealed: true, votes: { "1": "a" }, match: "a" }),
    ]) {
      const h = makeHarness();
      h.show(finishedLeaking(leakedVote));
      expect(h.pane.querySelector(".wx-srv-ck-voter")).toBeNull();
      expect(h.pane.querySelector(".wx-srv-ck-dinner")).toBeNull();
      expect(h.pane.querySelector(".wx-srv-ck-dish-dinner")).toBeNull();
      expect(h.pane.querySelector(".wx-srv-ck-vote-match")).toBeNull();
      // Only the viewer's own button is pressed; the partner's choice (dish c) shows nothing.
      expect(qa(h.pane, ".wx-srv-ck-vote[aria-pressed='true']").map((b) => b.closest<HTMLElement>(".wx-srv-ck-dish")?.dataset["concept"])).toEqual(["a"]);
      expect(q(h.pane, '.wx-srv-ck-dish[data-concept="c"]').textContent).not.toContain("Cupcake");
      expect(q(h.pane, ".wx-srv-ck-vote-banner").textContent).toBe("🍽️ Your vote is in (secret). Waiting for Cupcake…");
      document.body.replaceChildren();
    }
  });

  it("a correctly filtered view reads the same as the leaking one", () => {
    const clean = makeHarness();
    clean.show(finishedLeaking(readyVote({ you: "a", partnerVoted: true }), { partner: null }));
    const dirty = makeHarness();
    dirty.show(finishedLeaking(readyVote({ you: "a", partnerVoted: true, votes: { "1": "a", "2": "c" } }), {}));
    const strip = (pane: HTMLElement): string => pane.querySelector(".wx-srv-ck-scroll")?.outerHTML ?? "";
    expect(strip(dirty.pane)).toBe(strip(clean.pane));
  });

  it("once both votes are in and revealed, the badges appear (and not before)", () => {
    const h = makeHarness();
    h.show(finishedLeaking(readyVote({ you: "a", partnerVoted: true })));
    expect(h.pane.querySelector(".wx-srv-ck-voter")).toBeNull();
    h.show(finishedLeaking(readyVote({ you: "a", partnerVoted: true, revealed: true, votes: { "1": "a", "2": "c" } })));
    expect(qa(h.pane, ".wx-srv-ck-voter").map((b) => b.textContent)).toEqual(["🍽️ You", "🍽️ Cupcake"]);
    expect(q(q(h.pane, '.wx-srv-ck-dish[data-concept="c"]'), ".wx-srv-ck-voter").textContent).toBe("🍽️ Cupcake");
  });

  it("the stars show on both sides only at their own reveal", () => {
    const h = makeHarness();
    h.show(finishedLeaking(null));
    expect(qa(h.pane, ".wx-srv-ck-reveal-chip.wx-srv-ck-chip-starred")).toHaveLength(1);
    h.show(finishedLeaking(null, { revealed: true }));
    expect(qa(h.pane, ".wx-srv-ck-reveal-chip.wx-srv-ck-chip-starred").map((c) => c.dataset["picked"]).sort()).toEqual(["dark-brown-sugar", "double-espresso"]);
  });

  it("an abandoned Blind round reveals nothing: not the partner's picks, chaos pair or star", () => {
    const h = makeHarness();
    h.show({ ...leaking(6), state: "abandoned", current: null });
    expectNoPartnerStrings(h.pane, "abandoned");
    expect(h.pane.querySelector(".wx-srv-ck-pill-star")).toBeNull();
  });
});

describe("a swap after only one vote: the earlier set shows no vote at all", () => {
  function swapped(viewer: Json | null, archivedVote: Json): Json {
    return twistFinished(
      { concepts: "ready", images: "done" },
      {
        generation: 2,
        ...(viewer === null ? { you: null } : { you: viewer }),
        swap: swap({ state: "done", by: 1, out: TOMATOES, in: LENTILS }),
        vote: readyVote(),
        generations: [earlierSet(1, { vote: archivedVote })],
      },
    );
  }

  function earlierPane(h: Harness): HTMLElement {
    q<HTMLButtonElement>(h.pane, ".wx-srv-ck-earlier-toggle").click();
    return q(h.pane, ".wx-srv-ck-earlier");
  }

  const viewers: ReadonlyArray<[string, Json | null]> = [
    ["the voter", { slot: 1, chaosUsed: false, vetoUsed: false }],
    ["the partner", { slot: 2, chaosUsed: false, vetoUsed: false }],
    ["a non-player", null],
  ];

  for (const [who, viewer] of viewers) {
    it(`${who} sees no voter badge or crown for a set only one player voted on, even if the server sent the vote`, () => {
      for (const sent of [{ votes: { "1": "b" }, match: "b" }, { votes: { "1": "b" }, match: null }, { votes: null, match: "b" }, { votes: null, match: null }]) {
        const h = makeHarness();
        h.show(swapped(viewer, sent));
        const earlier = earlierPane(h);
        expect(earlier.querySelectorAll(".wx-srv-ck-voter"), JSON.stringify(sent)).toHaveLength(0);
        expect(earlier.querySelectorAll(".wx-srv-ck-dinner")).toHaveLength(0);
        expect(earlier.querySelectorAll(".wx-srv-ck-dish-dinner")).toHaveLength(0);
        expect(earlier.querySelectorAll(".wx-srv-ck-vote")).toHaveLength(0);
        document.body.replaceChildren();
      }
    });
  }

  it("a both-voted archive reveals its result: badges, or the crown on a match", () => {
    const split = makeHarness();
    split.show(swapped({ slot: 1, chaosUsed: false, vetoUsed: false }, { votes: { "1": "a", "2": "b" }, match: null }));
    const earlierSplit = earlierPane(split);
    expect(qa(q(earlierSplit, '.wx-srv-ck-dish-earlier[data-concept="a"]'), ".wx-srv-ck-voter").map((b) => b.textContent)).toEqual(["🍽️ You"]);
    expect(qa(q(earlierSplit, '.wx-srv-ck-dish-earlier[data-concept="b"]'), ".wx-srv-ck-voter").map((b) => b.textContent)).toEqual(["🍽️ Cupcake"]);
    document.body.replaceChildren();
    const agreed = makeHarness();
    agreed.show(swapped({ slot: 2, chaosUsed: false, vetoUsed: false }, { votes: { "1": "c", "2": "c" }, match: "c" }));
    const earlierAgreed = earlierPane(agreed);
    const crown = q(q(earlierAgreed, '.wx-srv-ck-dish-earlier[data-concept="c"]'), ".wx-srv-ck-dinner");
    expect(crown.textContent).toBe("🎯 Tonight's dinner!");
    expect(earlierAgreed.querySelectorAll(".wx-srv-ck-dinner")).toHaveLength(1);
  });

  it("the current set's own vote is unaffected by the archive", () => {
    const h = makeHarness();
    h.show(swapped({ slot: 1, chaosUsed: false, vetoUsed: false }, { votes: { "1": "b" }, match: null }));
    expect(qa(h.pane, ".wx-srv-ck-dishes:not(.wx-srv-ck-earlier-dishes) .wx-srv-ck-vote")).toHaveLength(3);
  });
});

describe("the other direction of the same lock (Open mode keeps what is public)", () => {
  it("an Open pane still shows the partner's public picks and a chaos pair", () => {
    const h = makeHarness();
    h.show(twistPicking({ you: 1, turn: 4, options: [DURIAN, NATTO] }, {}, { chaosPair: true }));
    expect(h.pane.outerHTML).toContain("Fresh durian");
    expect(h.pane.outerHTML).toContain("Ribeye steak");
    expect(h.pane.querySelector(".wx-srv-ck-chaos-note")).not.toBeNull();
  });
});
