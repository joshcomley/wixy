// What the public Adventure Time page remembers about this browser (spec/adventure-public section 2.4):
// the places banked ("Yay"), the places never to show again ("Nay") and the one setting, all in
// `localStorage` and nowhere else - the server never learns any of it.
//
//   advPublic.v1.banked   [{ code, destinationId, unitId, at }]   oldest first, at = epoch seconds
//   advPublic.v1.rejected [destinationId, ...]
//   advPublic.v1.settings { includeAdvised: boolean }
//
// Storage is allowed to be missing, full, blocked or corrupt (private browsing, a policy, a hand-edited
// value): nothing here ever throws. Every call reads the keys fresh when it can (so a second tab's
// change is seen) and tolerates a wrong shape entry by entry; when the storage cannot be read at all
// the last known values - this visit's own - are used, and once a write has failed this visit's own copy
// leads from then on, so what the person did still holds until they leave.
// Names are NOT stored: the page resolves them from the public bank at read time, so a renamed place
// shows its current name.

export interface BankedEntry {
  readonly code: string;
  readonly destinationId: string;
  readonly unitId: string;
  /** When it was banked, epoch seconds. */
  readonly at: number;
}

export interface Memory {
  /** Banked places, newest first. */
  banked(): readonly BankedEntry[];
  /** Destination ids never to show again. */
  rejected(): ReadonlySet<string>;
  /** Everything out of play in a draw: the never-again ids and the banked ones. */
  taken(): ReadonlySet<string>;
  includeAdvised(): boolean;
  /** Bank a place (idempotent per place; a place banked is no longer on the never-again list). */
  bank(entry: BankedEntry): void;
  /** Never show a place again (idempotent; a place rejected leaves the bank). */
  reject(destinationId: string): void;
  setIncludeAdvised(include: boolean): void;
  /** Clears the bank and the never-again list (the setting is left alone). */
  forgetEverything(): void;
  /** False when this browser would not keep anything past the visit (blocked or full storage). */
  readonly persistent: boolean;
}

export const BANKED_KEY = "advPublic.v1.banked";
export const REJECTED_KEY = "advPublic.v1.rejected";
export const SETTINGS_KEY = "advPublic.v1.settings";

/** More than the bank itself could ever hold: a bound for a corrupt or hostile value, not a limit that bites. */
const MAX_ENTRIES = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBanked(raw: string | null): BankedEntry[] | null {
  if (raw === null) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(json)) return null;
  const out: BankedEntry[] = [];
  const seen = new Set<string>();
  for (const item of (json as unknown[]).slice(0, MAX_ENTRIES)) {
    if (!isRecord(item)) continue;
    const code = item["code"];
    const destinationId = item["destinationId"];
    const unitId = item["unitId"];
    const at = item["at"];
    if (typeof code !== "string" || typeof destinationId !== "string" || typeof unitId !== "string") continue;
    if (code === "" || destinationId === "" || seen.has(destinationId)) continue;
    seen.add(destinationId);
    out.push({ code, destinationId, unitId, at: typeof at === "number" && Number.isFinite(at) ? at : 0 });
  }
  return out;
}

function parseRejected(raw: string | null): string[] | null {
  if (raw === null) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(json)) return null;
  const out = new Set<string>();
  for (const item of (json as unknown[]).slice(0, MAX_ENTRIES)) {
    if (typeof item === "string" && item !== "") out.add(item);
  }
  return [...out];
}

function parseIncludeAdvised(raw: string | null): boolean | null {
  if (raw === null) return false;
  try {
    const json: unknown = JSON.parse(raw);
    return isRecord(json) && json["includeAdvised"] === true;
  } catch {
    return null;
  }
}

/**
 * The page's memory over a storage. `getStorage` is asked on every call (touching `window.localStorage`
 * can itself throw); null or a throw means "no storage": this visit's own copy is used.
 */
export function createMemory(getStorage: () => Storage | null): Memory {
  // This visit's copy: the fallback for a storage that cannot be read, and the value a failed write leaves.
  let bankedMirror: BankedEntry[] = [];
  let rejectedMirror: string[] = [];
  let includeAdvisedMirror = false;
  let persistent = true;

  function storage(): Storage | null {
    try {
      return getStorage();
    } catch {
      return null;
    }
  }

  function readRaw(key: string): { readonly ok: true; readonly raw: string | null } | { readonly ok: false } {
    const s = storage();
    if (s === null) return { ok: false };
    try {
      return { ok: true, raw: s.getItem(key) };
    } catch {
      return { ok: false };
    }
  }

  function write(key: string, value: string): void {
    const s = storage();
    if (s === null) {
      persistent = false;
      return;
    }
    try {
      s.setItem(key, value);
    } catch {
      persistent = false;
    }
  }

  function readBanked(): BankedEntry[] {
    // Once a write has failed, storage no longer holds what this visit did: the visit's own copy leads.
    if (!persistent) return bankedMirror;
    const read = readRaw(BANKED_KEY);
    if (!read.ok) return bankedMirror;
    // A value that is not a list at all (corrupt) counts as empty and is overwritten by the next write.
    bankedMirror = parseBanked(read.raw) ?? [];
    return bankedMirror;
  }

  function readRejected(): string[] {
    if (!persistent) return rejectedMirror;
    const read = readRaw(REJECTED_KEY);
    if (!read.ok) return rejectedMirror;
    rejectedMirror = parseRejected(read.raw) ?? [];
    return rejectedMirror;
  }

  function saveBanked(entries: BankedEntry[]): void {
    bankedMirror = entries;
    write(BANKED_KEY, JSON.stringify(entries.map((e) => ({ code: e.code, destinationId: e.destinationId, unitId: e.unitId, at: e.at }))));
  }

  function saveRejected(ids: string[]): void {
    rejectedMirror = ids;
    write(REJECTED_KEY, JSON.stringify(ids));
  }

  return {
    banked: () => [...readBanked()].reverse(),
    rejected: () => new Set(readRejected()),
    taken: () => new Set([...readRejected(), ...readBanked().map((e) => e.destinationId)]),
    includeAdvised() {
      if (!persistent) return includeAdvisedMirror;
      const read = readRaw(SETTINGS_KEY);
      if (!read.ok) return includeAdvisedMirror;
      includeAdvisedMirror = parseIncludeAdvised(read.raw) ?? false;
      return includeAdvisedMirror;
    },
    bank(entry) {
      const banked = readBanked().filter((e) => e.destinationId !== entry.destinationId);
      banked.push(entry);
      saveBanked(banked);
      const rejected = readRejected();
      if (rejected.includes(entry.destinationId)) saveRejected(rejected.filter((id) => id !== entry.destinationId));
    },
    reject(destinationId) {
      const rejected = readRejected();
      if (!rejected.includes(destinationId)) saveRejected([...rejected, destinationId]);
      const banked = readBanked();
      if (banked.some((e) => e.destinationId === destinationId)) saveBanked(banked.filter((e) => e.destinationId !== destinationId));
    },
    setIncludeAdvised(include) {
      includeAdvisedMirror = include;
      write(SETTINGS_KEY, JSON.stringify({ includeAdvised: include }));
    },
    forgetEverything() {
      saveBanked([]);
      saveRejected([]);
    },
    get persistent() {
      return persistent;
    },
  };
}
