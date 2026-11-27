import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MIN_SPACING_KM, PublicBank, distanceKm, parsePublicBank } from "../../src/public/bank";
import { fixtureBank, fixtureBankJson } from "./publicFixtures";

// ---- the real bank, and the golden answers of the Python reference ------------------------------------

interface RawDest {
  id: string;
  name: string;
  region: string;
  lat: number;
  lng: number;
  kind: string;
  blurb: string;
}
interface RawUnit {
  name: string;
  advice: { level: string; checked: string } | null;
  destinations: RawDest[];
}
interface Golden {
  bankSha256: string;
  units: number;
  top: Array<{ unit: string; excluded: number[]; n: number; top: number[] }>;
  eligible: Array<{ emptied: string[]; firsts: string[]; includeAdvised: boolean; eligible: string[] }>;
  advised: string[];
}

// Vitest runs from admin-ui/.
const BANK_FILE = resolve(process.cwd(), "../wixy_server/livechat/adventure_destinations.json");
const GOLDEN_FILE = resolve(process.cwd(), "tests/public/topDestinations.golden.json");
const bankText = readFileSync(BANK_FILE, "utf-8");
const golden = JSON.parse(readFileSync(GOLDEN_FILE, "utf-8")) as Golden;
const rawBank = JSON.parse(bankText) as { countries: Record<string, RawUnit> };

/** The real bank in the public wire shape (the server adds a code per destination; here a stand-in). */
function realPublicBank(): PublicBank {
  const countries: Record<string, unknown> = {};
  let n = 0;
  for (const [id, unit] of Object.entries(rawBank.countries)) {
    countries[id] = {
      name: unit.name,
      advice: unit.advice,
      destinations: unit.destinations.map((d) => ({ ...d, code: `c${(n += 1).toString(36).padStart(5, "0")}` })),
    };
  }
  const bank = parsePublicBank({ version: 1, countries });
  if (bank === null) throw new Error("the real bank did not parse");
  return bank;
}

describe("the TS port of AdventureBank against the Python reference (golden)", () => {
  const bank = realPublicBank();

  it("was generated from the bank that is in the repo (regenerate: PYTHONPATH=. python admin-ui/tests/public/gen_golden.py)", () => {
    const sha = createHash("sha256").update(bankText.replace(/\r\n/g, "\n")).digest("hex");
    expect(golden.bankSha256).toBe(sha);
    expect(bank.units.size).toBe(golden.units);
  });

  it("top_destinations: every case matches, exactly (3558 cases over every unit)", () => {
    expect(golden.top.length).toBeGreaterThan(3000);
    let checked = 0;
    for (const c of golden.top) {
      const unit = bank.unit(c.unit);
      if (unit === undefined) throw new Error(`unit ${c.unit} missing`);
      const excluded = new Set(c.excluded.map((i) => (unit.destinations[i] as { id: string }).id));
      const got = bank.topDestinations(c.unit, excluded, c.n).map((d) => unit.destinations.indexOf(d));
      if (JSON.stringify(got) !== JSON.stringify(c.top)) {
        throw new Error(`top_destinations(${c.unit}, excluded ${JSON.stringify(c.excluded)}, n ${c.n}): ts ${JSON.stringify(got)} != python ${JSON.stringify(c.top)}`);
      }
      checked += 1;
    }
    expect(checked).toBe(golden.top.length);
  });

  it("the golden set exercises the spacing rule and its shortfall fill (some unit's top five is not simply its first five)", () => {
    const differs = golden.top.filter((c) => c.n === 5 && c.excluded.length === 0 && JSON.stringify(c.top) !== JSON.stringify([0, 1, 2, 3, 4].slice(0, c.top.length)));
    expect(differs.length).toBeGreaterThan(0);
    expect(golden.top.some((c) => c.top.length < c.n)).toBe(true);
  });

  it("eligible_units: every case matches (advised units in and out, whole units emptied)", () => {
    expect(golden.eligible.length).toBeGreaterThan(20);
    for (const c of golden.eligible) {
      const excluded = new Set<string>();
      for (const unitId of c.emptied) for (const d of bank.unit(unitId)?.destinations ?? []) excluded.add(d.id);
      for (const unitId of c.firsts) excluded.add((bank.unit(unitId)?.destinations[0] as { id: string }).id);
      expect(bank.eligibleUnits(excluded, c.includeAdvised)).toEqual(c.eligible);
    }
  });

  it("advised_units: the same units in the same order", () => {
    expect(bank.advisedUnits().map((u) => u.id)).toEqual(golden.advised);
    expect(golden.advised.length).toBeGreaterThan(0);
  });

  it("reads the advice mark the way the Python bank does (advised = advice is present)", () => {
    for (const [id, unit] of Object.entries(rawBank.countries)) expect(bank.unit(id)?.advised).toBe(unit.advice !== null);
  });
});

// ---- the rules on the small fixture bank ----------------------------------------------------------------

describe("PublicBank rules", () => {
  const bank = fixtureBank();
  const none = new Set<string>();

  it("distanceKm is the great-circle distance (Lisbon to Porto is about 274 km)", () => {
    expect(distanceKm(38.7223, -9.1393, 41.1579, -8.6291)).toBeGreaterThan(270);
    expect(distanceKm(38.7223, -9.1393, 41.1579, -8.6291)).toBeLessThan(280);
    expect(distanceKm(10, 10, 10, 10)).toBe(0);
  });

  it("takes places in rank order, holding back one within 40 km of one already taken, then fills the shortfall", () => {
    // a1 and a2 are ~15 km apart: a2 is skipped while enough far places remain.
    expect(bank.topDestinations("AAA", none).map((d) => d.id)).toEqual(["AAA.a1", "AAA.a3", "AAA.a4", "AAA.a5", "AAA.a6"]);
    expect(distanceKm(3, 3, 3.1, 3.1)).toBeLessThan(MIN_SPACING_KM);
    // With only two far places left the skipped one fills in, and the answer is in rank order.
    const taken = new Set(["AAA.a3", "AAA.a4", "AAA.a5", "AAA.a6"]);
    expect(bank.topDestinations("AAA", taken).map((d) => d.id)).toEqual(["AAA.a1", "AAA.a2", "AAA.a7"]);
  });

  it("a skipped place is held back, never consumed: it comes round again once a pick is out of play", () => {
    expect(bank.topDestinations("AAA", new Set(["AAA.a1"])).map((d) => d.id)).toContain("AAA.a2");
  });

  it("remaining is the unit minus excluded; an unknown unit has nothing", () => {
    expect(bank.remaining("DDD", new Set(["DDD.d1"])).map((d) => d.id)).toEqual(["DDD.d2"]);
    expect(bank.remaining("ZZZ", none)).toEqual([]);
    expect(bank.topDestinations("ZZZ", none)).toEqual([]);
    expect(bank.topDestinations("DDD", new Set(["DDD.d1", "DDD.d2"]))).toEqual([]);
  });

  it("a whole-country advisory leaves a unit out of the draws unless switched on", () => {
    expect(bank.isPlayable("CCC")).toBe(false);
    expect(bank.isPlayable("CCC", true)).toBe(true);
    expect(bank.isPlayable("ZZZ", true)).toBe(false);
    expect(bank.eligibleUnits(none)).toEqual(["AAA", "BBB", "DDD"]);
    expect(bank.eligibleUnits(none, true)).toEqual(["AAA", "BBB", "CCC", "DDD"]);
    expect(bank.eligibleUnits(new Set(["BBB.b1"]))).toEqual(["AAA", "DDD"]);
    expect(bank.advisedUnits().map((u) => u.id)).toEqual(["CCC"]);
  });

  it("finds a place by id and by its short code", () => {
    expect(bank.destination("DDD.d2")?.name).toBe("Dune");
    expect(bank.unitOf("DDD.d2")?.id).toBe("DDD");
    expect(bank.byCode("ddddd2")?.dest.id).toBe("DDD.d2");
    expect(bank.byCode("nope00")).toBeNull();
    expect(bank.unitName("AAA")).toBe("Aland");
    expect(bank.unitName("ZZZ")).toBe("ZZZ");
  });
});

describe("parsePublicBank", () => {
  it("reads the wire shape", () => {
    const bank = parsePublicBank(fixtureBankJson());
    expect(bank?.units.size).toBe(4);
    expect(bank?.unit("CCC")?.advised).toBe(true);
    expect(bank?.unit("AAA")?.destinations[0]?.code).toBe("aaaaa1");
  });

  it("is defensive: not a bank, a bad destination, a missing or malformed code", () => {
    expect(parsePublicBank(null)).toBeNull();
    expect(parsePublicBank({})).toBeNull();
    expect(parsePublicBank({ countries: [] })).toBeNull();
    expect(parsePublicBank({ version: 1, countries: {} })).toBeNull();
    const good = { id: "AAA.x", name: "X", region: "R", lat: 1, lng: 2, kind: "city", blurb: "b", code: "abcdef" };
    const bank = parsePublicBank({
      version: 1,
      countries: {
        AAA: { name: "Aland", advice: null, destinations: [good, { ...good, id: "AAA.y", code: "SHORT" }, { ...good, id: "AAA.z", code: undefined }, { ...good, id: "AAA.w", lat: 400 }, "junk"] },
        BBB: { name: "Bland", advice: null, destinations: [{ ...good, id: "BBB.q", code: "NOPE!!" }] },
        CCC: "junk",
      },
    });
    expect(bank?.units.size).toBe(1);
    expect(bank?.unit("AAA")?.destinations.map((d) => d.id)).toEqual(["AAA.x"]);
  });
});
