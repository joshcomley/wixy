// The public Adventure Time destination bank, client side (spec/adventure-public section 2.3, 2.4).
//
// The page fetches `GET /api/bank` once: for every map unit its name, its UK travel-advice mark and its
// destinations in RANK order (most loved first), each with the short `code` its link is made of. This
// module parses that defensively and carries the TS PORT of the server's draw rules, so the local game
// (`localBackend.ts`) picks places exactly as the private game's server does:
//
//   - `remaining`        = the unit's destinations minus the ones out of play (never-again and banked ids),
//   - `topDestinations`  = `AdventureBank.top_destinations` (wixy_server/livechat/adventure_bank.py): walk the
//                          remaining places in rank order and take one only if it is at least 40 km
//                          (great-circle) from every one already taken, until five; when fewer than five
//                          qualify, fill the rest from the skipped ones in rank order; the result is in
//                          rank order and always has `min(5, remaining)` places,
//   - `isPlayable`       = in the bank, and not under a whole-country "advise against all travel" unless the
//                          person switched those back in,
//   - `eligibleUnits`    = playable units with at least one place remaining, by id.
//
// The Python implementation is the reference: `tests/public/topDestinations.golden.json` is generated from
// it over the real bank (`tests/public/gen_golden.py`) and the unit test pins this port to it exactly.

import { parseDest, type AdventureDest } from "../server/adventure/api";

/** Two places in one unit's top picks are at least this far apart (great-circle, km). */
export const MIN_SPACING_KM = 40;
/** How many places a country's destination roulette draws from. */
export const TOP_DESTINATIONS = 5;
const EARTH_RADIUS_KM = 6371.0088;

/** A destination with the short code its public link is made of. */
export interface PublicDest extends AdventureDest {
  readonly code: string;
}

export interface PublicUnit {
  readonly id: string;
  readonly name: string;
  /** Under a whole-country UK "advise against all travel": left out of the draws unless switched back in. */
  readonly advised: boolean;
  /** In rank order, most loved first. */
  readonly destinations: readonly PublicDest[];
}

/** Great-circle (haversine) distance in kilometres between two points in degrees. */
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const phi1 = lat1 * rad;
  const phi2 = lat2 * rad;
  const dPhi = phi2 - phi1;
  const dLambda = (lng2 - lng1) * rad;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export class PublicBank {
  private readonly byId = new Map<string, { readonly unit: PublicUnit; readonly dest: PublicDest }>();
  private readonly byCodeIndex = new Map<string, { readonly unit: PublicUnit; readonly dest: PublicDest }>();

  constructor(
    readonly version: number,
    readonly units: ReadonlyMap<string, PublicUnit>,
  ) {
    for (const unit of units.values()) {
      for (const dest of unit.destinations) {
        this.byId.set(dest.id, { unit, dest });
        this.byCodeIndex.set(dest.code, { unit, dest });
      }
    }
  }

  unit(unitId: string): PublicUnit | undefined {
    return this.units.get(unitId);
  }

  unitName(unitId: string): string {
    return this.units.get(unitId)?.name ?? unitId;
  }

  destination(destinationId: string): PublicDest | undefined {
    return this.byId.get(destinationId)?.dest;
  }

  unitOf(destinationId: string): PublicUnit | undefined {
    return this.byId.get(destinationId)?.unit;
  }

  /** The place a short code names, with its unit, or null. */
  byCode(code: string): { readonly unit: PublicUnit; readonly dest: PublicDest } | null {
    return this.byCodeIndex.get(code) ?? null;
  }

  isPlayable(unitId: string, includeAdvised = false): boolean {
    const unit = this.units.get(unitId);
    return unit !== undefined && (includeAdvised || !unit.advised);
  }

  /** The units under a whole-country "advise against all travel", by name then id. */
  advisedUnits(): readonly PublicUnit[] {
    return [...this.units.values()].filter((u) => u.advised).sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
  }

  /** The unit's destinations still in play (everything but `excluded`), in rank order. */
  remaining(unitId: string, excluded: ReadonlySet<string>): readonly PublicDest[] {
    const unit = this.units.get(unitId);
    return unit === undefined ? [] : unit.destinations.filter((d) => !excluded.has(d.id));
  }

  topDestinations(unitId: string, excluded: ReadonlySet<string>, n: number = TOP_DESTINATIONS): readonly PublicDest[] {
    const remaining = this.remaining(unitId, excluded);
    const taken: number[] = [];
    const skipped: number[] = [];
    for (let index = 0; index < remaining.length; index += 1) {
      if (taken.length === n) break;
      const candidate = remaining[index] as PublicDest;
      const spaced = taken.every((t) => {
        const other = remaining[t] as PublicDest;
        return distanceKm(candidate.lat, candidate.lng, other.lat, other.lng) >= MIN_SPACING_KM;
      });
      if (spaced) taken.push(index);
      else skipped.push(index);
    }
    for (const index of skipped) {
      if (taken.length === n) break;
      taken.push(index);
    }
    return taken.sort((a, b) => a - b).map((index) => remaining[index] as PublicDest);
  }

  /** Playable units with at least one place remaining, by id (stable order). */
  eligibleUnits(excluded: ReadonlySet<string>, includeAdvised = false): string[] {
    const ids: string[] = [];
    for (const unitId of this.units.keys()) {
      if (this.isPlayable(unitId, includeAdvised) && this.remaining(unitId, excluded).length > 0) ids.push(unitId);
    }
    return ids.sort(compareText);
  }
}

/** Code-point order, as Python's `sorted` on strings (ids and names compare the same way on both sides). */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CODE_PATTERN = /^[a-z0-9]{6,12}$/;

/**
 * The page's bank from `GET /api/bank`, or null when the document is not one. A destination that does not
 * parse (or has no usable code) is dropped; a unit left with none is dropped with it.
 */
export function parsePublicBank(json: unknown): PublicBank | null {
  if (!isRecord(json) || !isRecord(json["countries"])) return null;
  const version = typeof json["version"] === "number" ? json["version"] : 0;
  const units = new Map<string, PublicUnit>();
  for (const [unitId, rawUnit] of Object.entries(json["countries"])) {
    if (!isRecord(rawUnit) || !Array.isArray(rawUnit["destinations"])) continue;
    const name = typeof rawUnit["name"] === "string" && rawUnit["name"] !== "" ? rawUnit["name"] : unitId;
    const destinations: PublicDest[] = [];
    for (const rawDest of rawUnit["destinations"] as unknown[]) {
      const dest = parseDest(rawDest);
      const code = isRecord(rawDest) ? rawDest["code"] : undefined;
      if (dest === null || typeof code !== "string" || !CODE_PATTERN.test(code)) continue;
      destinations.push({ ...dest, code });
    }
    if (destinations.length === 0) continue;
    units.set(unitId, { id: unitId, name, advised: rawUnit["advice"] !== null && rawUnit["advice"] !== undefined, destinations });
  }
  return units.size === 0 ? null : new PublicBank(version, units);
}
