// The per-device "Keep this device unlocked" state (spec/server-chat/
// 03-permanent-unlock.md §4). Two localStorage keys and nothing else:
//
// - `wx-srv-device-grant` = JSON `{"grantId", "secret"}`. PRESENT means the setting is on.
//   The secret is the credential the server minted for THIS device; it can mint a normal
//   unlock token but is not one (Inv 41 — the token itself never leaves JS memory).
// - `wx-srv-grant-paused` = "1" after a deliberate lock (panic, multi-tap, Escape) or a
//   lock the owner asked for with a checkbox. While paused the grant is ignored, so a
//   panic survives a reload and a bystander cannot undo it; a successful PIN unlock clears
//   it.
//
// Unreadable, malformed or unwritable storage always means OFF: the device falls back to
// the ordinary PIN flow, never to a looser one.

export const DEVICE_GRANT_KEY = "wx-srv-device-grant";
export const GRANT_PAUSED_KEY = "wx-srv-grant-paused";
export const GRANT_STATE_CHANGED_EVENT = "wx-srv-grant-state-changed";

export interface StoredDeviceGrant {
  readonly grantId: string;
  readonly secret: string;
}

const GRANT_ID_PATTERN = /^[0-9a-f]{32}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_LABEL_CHARS = 80;

/** The stored grant, or `null` when there is none or it is not exactly what the server
 * hands out (a tampered or truncated value must not be sent anywhere). */
export function readDeviceGrant(win: Window): StoredDeviceGrant | null {
  let raw: string | null;
  try {
    raw = win.localStorage.getItem(DEVICE_GRANT_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const grantId = record["grantId"];
  const secret = record["secret"];
  if (typeof grantId !== "string" || !GRANT_ID_PATTERN.test(grantId)) return null;
  if (typeof secret !== "string" || !SECRET_PATTERN.test(secret)) return null;
  return { grantId, secret };
}

export function isDeviceGrantPaused(win: Window): boolean {
  try {
    return win.localStorage.getItem(GRANT_PAUSED_KEY) === "1";
  } catch {
    // Unreadable: treat as paused — the safe direction (the PIN is asked for).
    return true;
  }
}

/** The setting is on AND not paused: automatic locks stay quiet and the panel opens
 * straight into the chat. */
export function isGrantActive(win: Window): boolean {
  return readDeviceGrant(win) !== null && !isDeviceGrantPaused(win);
}

function announce(win: Window): void {
  win.dispatchEvent(new Event(GRANT_STATE_CHANGED_EVENT));
}

/** Stores a freshly minted grant (clearing any pause) and reports whether it really stuck.
 * A refused write leaves the setting off, so the caller says so instead of pretending. */
export function storeDeviceGrant(win: Window, grant: StoredDeviceGrant): boolean {
  try {
    win.localStorage.setItem(DEVICE_GRANT_KEY, JSON.stringify({ grantId: grant.grantId, secret: grant.secret }));
    win.localStorage.removeItem(GRANT_PAUSED_KEY);
  } catch {
    // Fall through to the read-back: it decides what stuck.
  }
  const stuck = readDeviceGrant(win)?.grantId === grant.grantId;
  announce(win);
  return stuck;
}

/** Turns the setting off on this device: both keys removed. */
export function clearDeviceGrant(win: Window): void {
  try {
    win.localStorage.removeItem(DEVICE_GRANT_KEY);
    win.localStorage.removeItem(GRANT_PAUSED_KEY);
  } catch {
    // Nothing more can be done from here; the next read decides.
  }
  announce(win);
}

/** Pauses (`true`) or resumes (`false`) the grant. If a pause cannot be written the grant
 * itself is dropped: an unwritable pause would let the next reload undo a panic. */
export function setGrantPaused(win: Window, paused: boolean): void {
  try {
    if (paused) win.localStorage.setItem(GRANT_PAUSED_KEY, "1");
    else win.localStorage.removeItem(GRANT_PAUSED_KEY);
  } catch {
    if (paused) {
      try {
        win.localStorage.removeItem(DEVICE_GRANT_KEY);
      } catch {
        // Both keys unwritable: storage is dead, and `readDeviceGrant` will say so.
      }
    }
  }
  announce(win);
}

/** Calls `listener` whenever the grant state may have changed — in this window, or (via the
 * `storage` event) another tab of this device. Returns the unsubscribe function. */
export function onGrantStateChanged(win: Window, listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === DEVICE_GRANT_KEY || event.key === GRANT_PAUSED_KEY) listener();
  };
  win.addEventListener(GRANT_STATE_CHANGED_EVENT, listener);
  win.addEventListener("storage", onStorage);
  return () => {
    win.removeEventListener(GRANT_STATE_CHANGED_EVENT, listener);
    win.removeEventListener("storage", onStorage);
  };
}

/** A short display-only name for this device, e.g. "Android · Chrome". Never used for
 * anything but a label the server stores. */
export function deviceLabel(win: Window): string {
  const ua = win.navigator.userAgent;
  const platform = /Android/i.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/i.test(ua)
      ? "iOS"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Macintosh|Mac OS X/i.test(ua)
          ? "Mac"
          : /CrOS/i.test(ua)
            ? "ChromeOS"
            : /Linux/i.test(ua)
              ? "Linux"
              : "Device";
  const browser = /Edg\//i.test(ua)
    ? "Edge"
    : /Firefox|FxiOS/i.test(ua)
      ? "Firefox"
      : /Chrome|CriOS/i.test(ua)
        ? "Chrome"
        : /Safari/i.test(ua)
          ? "Safari"
          : "Browser";
  return `${platform} · ${browser}`.slice(0, MAX_LABEL_CHARS);
}
