// Which received voice notes this device has listened to (or dismissed). Per-device, like the
// other chat preferences: the server never learns what was heard, and nothing here is sent
// anywhere. Anything unreadable degrades to "nothing remembered" — never to a thrown error.

const KEY = "wx-srv-voice-heard";
/** Oldest entries fall off past this many remembered notes. */
export const HEARD_MAX_IDS = 1000;
/** A note counts as listened to once playback reaches this share of its length. */
export const HEARD_THRESHOLD = 0.9;

export interface HeardStore {
  /** Epoch seconds before which a voice note is never treated as unheard: the first moment this
   * device ran the feature, so a whole history of old notes does not appear as unheard at once. */
  since(): number;
  isHeard(attachmentId: string): boolean;
  /** Listened to, transcribed, or dismissed — all the same thing: no longer unheard. */
  markHeard(attachmentId: string): void;
}

interface Persisted {
  since: number;
  ids: string[];
}

export function createHeardStore(win: Window, nowMs: () => number = () => Date.now()): HeardStore {
  let state: Persisted | null = null;

  function load(): Persisted {
    if (state !== null) return state;
    let parsed: Persisted | null = null;
    try {
      const raw = win.localStorage.getItem(KEY);
      if (raw !== null) {
        const value: unknown = JSON.parse(raw);
        if (typeof value === "object" && value !== null) {
          const record = value as { since?: unknown; ids?: unknown };
          if (typeof record.since === "number" && Array.isArray(record.ids)) {
            parsed = {
              since: record.since,
              ids: record.ids.filter((id): id is string => typeof id === "string"),
            };
          }
        }
      }
    } catch {
      parsed = null;
    }
    state = parsed ?? { since: Math.floor(nowMs() / 1000), ids: [] };
    if (parsed === null) save();
    return state;
  }

  function save(): void {
    if (state === null) return;
    try {
      win.localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // Private mode / blocked storage: the in-memory copy still serves this page visit.
    }
  }

  return {
    since: () => load().since,
    isHeard: (attachmentId) => load().ids.includes(attachmentId),
    markHeard(attachmentId) {
      const current = load();
      if (current.ids.includes(attachmentId)) return;
      current.ids.push(attachmentId);
      if (current.ids.length > HEARD_MAX_IDS) current.ids.splice(0, current.ids.length - HEARD_MAX_IDS);
      save();
    },
  };
}
