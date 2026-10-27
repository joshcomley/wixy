// Adventure Time preview — the data the page carries inside itself (no fetches: the file is opened
// from a link, so relative requests would break) and the tiny bit of persistence the real game has:
// rejected destinations never come back, banked ones are not drawn again.

import type { LngLat } from "../../src/server/adventure/camera";

export interface Dest {
  readonly id: string;
  readonly name: string;
  readonly region: string;
  readonly lat: number;
  readonly lng: number;
  readonly kind: string;
  readonly blurb: string;
}

export interface BankCountry {
  readonly name: string;
  readonly advice: { readonly level: string; readonly checked: string } | null;
  readonly destinations: readonly Dest[];
}

export interface Bank {
  readonly version: number;
  readonly generated: string;
  readonly countries: Readonly<Record<string, BankCountry>>;
}

export interface PackItem {
  readonly name: string;
  readonly detail: string;
  readonly url: string | null;
}

export interface PackSection {
  readonly key: string;
  readonly title: string;
  readonly items: readonly PackItem[];
}

export interface Pack {
  readonly headline: string;
  readonly summary: string;
  readonly sections: readonly PackSection[];
  readonly bestTime: string;
  readonly gettingThere: string;
  readonly travelAdvice: string;
  readonly sources: ReadonlyArray<{ readonly title: string; readonly url: string }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readJson(id: string): unknown {
  const el = document.getElementById(id);
  if (el === null || el.textContent === null || el.textContent.trim() === "") return null;
  return JSON.parse(el.textContent);
}

export function loadWorldJson(): unknown {
  const json = readJson("adv-world");
  if (json === null) throw new Error("The page carries no world map.");
  return json;
}

export function loadBank(): Bank {
  const json = readJson("adv-bank");
  if (!isRecord(json) || !isRecord(json["countries"])) throw new Error("The page carries no destination bank.");
  return json as unknown as Bank;
}

/** The sample pack the page was built with, else a small example of the same shape. */
export function loadSamplePack(): Pack {
  const json = readJson("adv-pack");
  if (isRecord(json) && Array.isArray(json["sections"])) return json as unknown as Pack;
  return BUILTIN_PACK;
}

const BUILTIN_PACK: Pack = {
  headline: "A sunny, walkable town of tiled streets, grilled fish and golden-hour viewpoints",
  summary:
    "This is a built-in example of a holiday pack. The real game researches the place you land on, live on the internet, and fills in food, places to stay, culture, sights and things to do.",
  sections: [
    {
      key: "food",
      title: "Food and drink",
      items: [
        { name: "The dish everyone orders", detail: "What the area is known for, and where locals actually eat it.", url: "https://example.com/food" },
        { name: "A harbour-side grill", detail: "Fresh fish by weight, plain and brilliant. Book ahead in season.", url: null },
      ],
    },
    {
      key: "stay",
      title: "Where to stay",
      items: [
        { name: "A hillside villa with a pool", detail: "Sleeps six, ten minutes from the old town on foot.", url: "https://example.com/villa" },
        { name: "A characterful old-town guesthouse", detail: "Five rooms, a roof terrace and breakfast included.", url: null },
      ],
    },
    {
      key: "sights",
      title: "Sights",
      items: [{ name: "The old town walls", detail: "Walk the full circuit at sunset; allow ninety minutes.", url: null }],
    },
  ],
  bestTime: "May to June and September: warm, quieter and cheaper than high summer.",
  gettingThere: "Fly to the nearest airport, then a short transfer by road.",
  travelAdvice: "Check the current UK government travel advice before you book.",
  sources: [{ title: "Example source", url: "https://example.com" }],
};

// -- Persistence -------------------------------------------------------------------------------------

const KEY_REJECTED = "advPreview.rejected";
const KEY_BANKED = "advPreview.banked";
const KEY_SETTINGS = "advPreview.settings";

export interface BankedTrip {
  readonly unitId: string;
  readonly unitName: string;
  readonly dest: Dest;
  readonly at: number;
}

export interface Settings {
  playOther: boolean;
  /** Include places under a whole-country UK "advise against all travel" (off by default). */
  includeAdvised: boolean;
  showDebug: boolean;
  /** null = follow the system preference. */
  reducedMotion: boolean | null;
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode / blocked storage: the preview still works for this visit
  }
}

export class Memory {
  rejected: Set<string>;
  banked: BankedTrip[];
  settings: Settings;

  constructor() {
    const rejected = load<unknown>(KEY_REJECTED, []);
    this.rejected = new Set(Array.isArray(rejected) ? rejected.filter((v): v is string => typeof v === "string") : []);
    const banked = load<unknown>(KEY_BANKED, []);
    this.banked = Array.isArray(banked) ? (banked as BankedTrip[]).filter((t) => isRecord(t) && isRecord(t["dest"])) : [];
    const settings = load<Partial<Settings>>(KEY_SETTINGS, {});
    this.settings = {
      playOther: settings.playOther === true,
      includeAdvised: settings.includeAdvised === true,
      showDebug: settings.showDebug === true,
      reducedMotion: typeof settings.reducedMotion === "boolean" ? settings.reducedMotion : null,
    };
  }

  isTaken(destId: string): boolean {
    return this.rejected.has(destId) || this.banked.some((t) => t.dest.id === destId);
  }

  reject(destId: string): void {
    this.rejected.add(destId);
    save(KEY_REJECTED, [...this.rejected]);
  }

  bank(trip: BankedTrip): void {
    this.banked = [trip, ...this.banked.filter((t) => t.dest.id !== trip.dest.id)];
    save(KEY_BANKED, this.banked);
  }

  forgetAll(): void {
    this.rejected.clear();
    this.banked = [];
    save(KEY_REJECTED, []);
    save(KEY_BANKED, []);
  }

  saveSettings(): void {
    save(KEY_SETTINGS, this.settings);
  }
}

/**
 * Bank units the world has with a destination still to draw. Units under a whole-country UK "advise
 * against all travel" are left out unless `includeAdvised` (the operator's switch).
 */
export function eligibleUnits(
  bank: Bank,
  memory: Memory,
  hasUnit: (id: string) => boolean,
  includeAdvised: boolean,
): Set<string> {
  const out = new Set<string>();
  for (const [id, country] of Object.entries(bank.countries)) {
    if ((country.advice !== null && !includeAdvised) || !hasUnit(id)) continue;
    if (country.destinations.some((d) => !memory.isTaken(d.id))) out.add(id);
  }
  return out;
}

/** The top five destinations of a unit that are still in play, in rank order. */
export function topFive(bank: Bank, memory: Memory, unitId: string): Dest[] {
  const country = bank.countries[unitId];
  if (country === undefined) return [];
  return country.destinations.filter((d) => !memory.isTaken(d.id)).slice(0, 5);
}

export function destPoint(d: Dest): LngLat {
  return [d.lng, d.lat];
}
