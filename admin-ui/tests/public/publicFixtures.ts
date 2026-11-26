// Shared fixtures for the public Adventure Time tests: a small bank whose units match the test world
// (AAA, BBB, CCC) plus one extra, a memory over a fake storage, and a scripted pack client.

import type { SpinResultInput } from "../../src/server/adventure/api";
import { PublicBank, type PublicDest, type PublicUnit } from "../../src/public/bank";
import { createMemory, type Memory } from "../../src/public/memory";
import type { PackAnswer, PackClient } from "../../src/public/packClient";
import type { PackView } from "../../src/server/adventure/api";

export function pdest(id: string, name: string, lng: number, lat: number, code: string): PublicDest {
  return { id, name, region: `${name} region`, lat, lng, kind: "city", blurb: `${name} is lovely.`, code };
}

/**
 * AAA: seven places; a1 and a2 are about 15 km apart (the spacing rule must hold a2 back), the rest are far
 * apart. BBB: exactly ONE place (the one-left skip). CCC: two places, under a whole-country advisory.
 * DDD: two places.
 */
export function fixtureUnits(): PublicUnit[] {
  return [
    {
      id: "AAA",
      name: "Aland",
      advised: false,
      destinations: [
        pdest("AAA.a1", "Alpha", 3, 3, "aaaaa1"),
        pdest("AAA.a2", "Alpine", 3.1, 3.1, "aaaaa2"),
        pdest("AAA.a3", "Amber", 6, 6, "aaaaa3"),
        pdest("AAA.a4", "Anchor", 9, 9, "aaaaa4"),
        pdest("AAA.a5", "Arrow", 1, 9, "aaaaa5"),
        pdest("AAA.a6", "Aspen", 9, 1, "aaaaa6"),
        pdest("AAA.a7", "Atlas", 5, 8, "aaaaa7"),
      ],
    },
    { id: "BBB", name: "Bland", advised: false, destinations: [pdest("BBB.b1", "Bravo", 15, 4, "bbbbb1")] },
    {
      id: "CCC",
      name: "Cland",
      advised: true,
      destinations: [pdest("CCC.c1", "Charlie", 35, -5, "ccccc1"), pdest("CCC.c2", "Cobalt", 37, -3, "ccccc2")],
    },
    {
      id: "DDD",
      name: "Dland",
      advised: false,
      destinations: [pdest("DDD.d1", "Delta", 60, 10, "ddddd1"), pdest("DDD.d2", "Dune", 64, 14, "ddddd2")],
    },
  ];
}

export function fixtureBank(): PublicBank {
  return new PublicBank(1, new Map(fixtureUnits().map((u) => [u.id, u])));
}

/** The wire form of `GET /api/bank` for the fixture bank (advice as the server sends it). */
export function fixtureBankJson(): Record<string, unknown> {
  const countries: Record<string, unknown> = {};
  for (const unit of fixtureUnits()) {
    countries[unit.id] = {
      name: unit.name,
      advice: unit.advised ? { level: "against_all_travel", checked: "2026-01-01" } : null,
      destinations: unit.destinations.map((d) => ({ ...d })),
    };
  }
  return { version: 1, countries };
}

/** A `Storage` over a Map (jsdom's own would persist across tests), optionally broken. */
export function fakeStorage(options: { throwOnGet?: boolean; throwOnSet?: boolean; initial?: Record<string, string> } = {}): Storage {
  const data = new Map<string, string>(Object.entries(options.initial ?? {}));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => {
      if (options.throwOnGet === true) throw new DOMException("blocked", "SecurityError");
      return data.get(key) ?? null;
    },
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      if (options.throwOnSet === true) throw new DOMException("quota", "QuotaExceededError");
      data.set(key, value);
    },
  };
}

export function fixtureMemory(storage: Storage = fakeStorage()): { memory: Memory; storage: Storage } {
  return { memory: createMemory(() => storage), storage };
}

export const T0 = 1_800_000_000_000;

/** A pack view the way the public server answers. */
export function packView(over: Partial<PackView> = {}): PackView {
  return { state: "pending", data: null, error: null, canRetry: false, images: "none", pictures: null, ...over };
}

export function readyPackView(over: Partial<PackView> = {}): PackView {
  return packView({
    state: "ready",
    data: {
      headline: "Sun and tiles",
      summary: "A warm place.",
      sections: [{ key: "food", title: "Food", items: [{ index: 0, name: "Tarts", detail: "Custard.", url: null }] }],
      bestTime: "May",
      gettingThere: "Fly.",
      travelAdvice: "No restrictions.",
      sources: [],
    },
    images: "done",
    ...over,
  });
}

export function ok(view: PackView, retryAfterS: number | null = null): PackAnswer {
  return { kind: "ok", view, retryAfterS };
}

/** A pack client whose answers are scripted per method; the last scripted answer repeats. */
export interface ScriptedPacks extends PackClient {
  readonly calls: Array<{ method: "get" | "post"; code: string }>;
  script(method: "get" | "post", ...answers: PackAnswer[]): void;
}

export function scriptedPacks(): ScriptedPacks {
  const scripts: Record<"get" | "post", PackAnswer[]> = { get: [ok(packView({ state: "none" }))], post: [ok(packView())] };
  const calls: ScriptedPacks["calls"] = [];
  const next = (method: "get" | "post", code: string): Promise<PackAnswer> => {
    calls.push({ method, code });
    const list = scripts[method];
    const answer = list.length > 1 ? (list.shift() as PackAnswer) : (list[0] as PackAnswer);
    return Promise.resolve(answer);
  };
  return {
    calls,
    script(method, ...answers) {
      scripts[method] = [...answers];
    },
    get: (code) => next("get", code),
    post: (code) => next("post", code),
  };
}

/** A lat spin's `result` over the fixture bank. */
export function landingResult(over: Partial<SpinResultInput> = {}): SpinResultInput {
  return {
    point: [1, 1],
    sea: false,
    land: [1, 1],
    centre: [2, 2],
    landUnit: "AAA",
    candidates: ["AAA", "BBB", "DDD"],
    ...over,
  };
}
