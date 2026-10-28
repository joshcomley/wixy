// Shared fixtures for the Adventure Time client tests (the pane, scene, model, card, bank): a tiny world of
// three countries and a family of round views, one per state of the round's life. Times are server epoch
// SECONDS, exactly as on the wire.

import type {
  AdventureDest,
  AdventureSpin,
  AdventureView,
  CountryStage,
  DestinationStage,
  PackView,
} from "../../src/server/adventure/api";
import { makeTopology, makeWorld, type UnitSpec } from "../fixtures/adventureWorld";
import type { World } from "../../src/server/adventure/world";

/** Three squares: AAA and BBB side by side (the landing is in AAA), CCC well to the east. */
const TEST_UNITS: readonly UnitSpec[] = [
  { id: "AAA", name: "Aland", rects: [[0, 0, 10, 10]] },
  { id: "BBB", name: "Bland", rects: [[12, 0, 22, 10]] },
  { id: "CCC", name: "Cland", rects: [[30, -10, 40, 0]] },
];

export function testWorld(): World {
  return makeWorld(TEST_UNITS);
}

/** The same world as the TopoJSON file the game fetches. */
export function testTopology(): Record<string, unknown> {
  return makeTopology(TEST_UNITS);
}

export const NOW = 1_800_000_000;

export function dest(id: string, name: string, lng: number, lat: number): AdventureDest {
  return { id, name, region: `${name} region`, lat, lng, kind: "city", blurb: `${name} is lovely.` };
}

export const DEST_A: AdventureDest = dest("AAA.alpha", "Alpha", 3, 3);
export const DEST_B: AdventureDest = dest("AAA.beta", "Beta", 7, 6);
export const DEST_C: AdventureDest = dest("AAA.gamma", "Gamma", 5, 8);

export function spin(by: string, from: number, delta: number, durationMs: number, at: number): AdventureSpin {
  return { by, from, delta, durationMs, at };
}

export const NO_PACK: PackView = { state: "none", data: null, error: null, canRetry: false, images: "none", pictures: null };

export function readyPack(): PackView {
  return {
    state: "ready",
    data: {
      headline: "Sun and tiles",
      summary: "A warm place.",
      sections: [
        { key: "food", title: "Food", items: [{ index: 0, name: "Tarts", detail: "Custard.", url: "https://example.com/tarts" }] },
      ],
      bestTime: "May",
      gettingThere: "Fly.",
      travelAdvice: "No restrictions.",
      sources: [{ title: "Visit", url: "https://example.com/visit" }],
    },
    error: null,
    canRetry: false,
    images: "none",
    pictures: null,
  };
}

export interface ViewParts {
  seq?: number;
  rev?: number;
  serverNow?: number;
  startedBy?: string;
  eligible?: string[] | null;
  lng?: AdventureSpin | null;
  lat?: AdventureSpin | null;
  landing?: AdventureView["landing"];
  country?: CountryStage | null;
  destination?: DestinationStage | null;
  pack?: PackView;
  decidedBy?: string | null;
}

/** A round in `state`, with the stage data a real server would hold for it filled in unless overridden. */
export function view(state: AdventureView["state"], parts: ViewParts = {}): AdventureView {
  const spinning = state === "spin_lng" || state === "spin_lat";
  const afterLat = !(spinning || state === "abandoned");
  const lng = parts.lng !== undefined ? parts.lng : state === "spin_lng" ? null : spin("Ann", 10, 1000, 4000, NOW - 100);
  const lat = parts.lat !== undefined ? parts.lat : afterLat ? spin("Bea", -15, 900, 4000, NOW - 60) : null;
  const landing =
    parts.landing !== undefined
      ? parts.landing
      : afterLat
        ? { point: [5, 5] as [number, number], sea: false, land: [5, 5] as [number, number], centre: [5, 5] as [number, number], landUnit: "AAA", landUnitName: "Aland" }
        : null;
  const country =
    parts.country !== undefined
      ? parts.country
      : afterLat
        ? {
            candidates: [
              { id: "AAA", name: "Aland" },
              { id: "BBB", name: "Bland" },
              { id: "CCC", name: "Cland" },
            ],
            seed: 12345,
            rouletteAt: NOW + 5,
            chosen: state === "country" ? null : { id: "AAA", name: "Aland" },
            by: state === "country" ? null : "Ann",
          }
        : null;
  const placed = state === "chosen" || state === "banked" || state === "rejected";
  const destination =
    parts.destination !== undefined
      ? parts.destination
      : state === "destination" || placed
        ? {
            candidates: [DEST_A, DEST_B, DEST_C],
            seed: 777,
            rouletteAt: NOW + 3.5,
            chosen: placed ? DEST_A : null,
            by: placed ? "Bea" : null,
          }
        : null;
  return {
    seq: parts.seq ?? 7,
    state,
    rev: parts.rev ?? 1,
    serverNow: parts.serverNow ?? NOW,
    startedBy: parts.startedBy ?? "Ann",
    eligible: parts.eligible !== undefined ? parts.eligible : spinning ? ["AAA", "BBB", "CCC"] : null,
    spins: { lng, lat },
    landing,
    country,
    destination,
    pack: parts.pack ?? (placed ? { ...NO_PACK, state: "pending" } : NO_PACK),
    decidedBy: parts.decidedBy !== undefined ? parts.decidedBy : state === "banked" || state === "rejected" ? "Ann" : null,
  };
}

/** The raw JSON a server sends for a view (what `parseAdventureView` reads): the typed view, re-shaped. */
export function wire(v: AdventureView): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      ...v,
      pack: {
        state: v.pack.state,
        data: v.pack.data,
        error: v.pack.error,
        canRetry: v.pack.canRetry,
      },
    }),
  ) as Record<string, unknown>;
}
