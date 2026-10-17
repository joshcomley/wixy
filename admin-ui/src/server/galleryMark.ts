// "Downloaded up to here", remembered per device (workspace 00046).
//
// The gallery's "Download Any Undownloaded" button saves media oldest-first and, after each file
// has fully arrived, moves this mark to it — so coming back days later it only fetches what was
// sent since, and an interrupted run resumes where it stopped. It is a per-browser convenience
// (localStorage), never state that matters: unreadable, blocked or cleared storage just means
// everything counts as not yet downloaded.

export interface DownloadMark {
  readonly seq: number;
  readonly ordinal: number;
  /** Epoch milliseconds of the last file saved (`Date.now()` — UTC by construction). */
  readonly at: number;
}

export interface DownloadMarkStore {
  read(): DownloadMark | null;
  write(mark: DownloadMark): void;
}

export const DOWNLOAD_MARK_KEY = "wixy.server.gallery.downloaded";

function isMark(value: unknown): value is DownloadMark {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["seq"] === "number" &&
    Number.isInteger(v["seq"]) &&
    typeof v["ordinal"] === "number" &&
    Number.isInteger(v["ordinal"]) &&
    typeof v["at"] === "number" &&
    Number.isFinite(v["at"])
  );
}

export function createDownloadMarkStore(win: Window, key: string = DOWNLOAD_MARK_KEY): DownloadMarkStore {
  function storage(): Storage | null {
    try {
      return win.localStorage;
    } catch {
      return null;
    }
  }
  return {
    read(): DownloadMark | null {
      try {
        const raw = storage()?.getItem(key) ?? null;
        if (raw === null) return null;
        const parsed: unknown = JSON.parse(raw);
        return isMark(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    write(mark: DownloadMark): void {
      try {
        storage()?.setItem(key, JSON.stringify(mark));
      } catch {
        // Private window / quota: the mark just does not stick.
      }
    },
  };
}

/** Whether `item` was sent after the mark (no mark: everything is new). */
export function isAfterMark(item: { readonly seq: number; readonly ordinal: number }, mark: DownloadMark | null): boolean {
  if (mark === null) return true;
  return item.seq > mark.seq || (item.seq === mark.seq && item.ordinal > mark.ordinal);
}
