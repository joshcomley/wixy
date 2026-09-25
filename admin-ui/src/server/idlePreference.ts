// The per-device "Extend auto-lock to 1 minute" preference. It is stored in
// this browser's localStorage only (like the display name in `identity.ts`) —
// nothing about it is ever sent to the server — and it can only be changed
// from inside the unlocked chat's settings sheet.
//
// Storage contract: the key holds "1" when the box is ticked and is ABSENT
// otherwise. Absent, unreadable (storage blocked / throws) or any other value
// means OFF, so a broken or tampered store can only ever fall back to the
// normal, shorter 10s lock — never to a longer one.
//
// The panel reads this every time it (re)starts the idle timer, and the
// settings sheet announces a change through `IDLE_PREFERENCE_CHANGED_EVENT` on
// the window (a `storage` event carries a change made in another tab), so a
// tick or untick applies at once without remounting anything.

import { IDLE_LOCK_EXTENDED_MS, IDLE_LOCK_MS } from "./constants";

export const IDLE_EXTENDED_KEY = "wx-srv-idle-extended";
export const IDLE_PREFERENCE_CHANGED_EVENT = "wx-srv-idle-preference-changed";

/** `true` only when the stored value is exactly "1". */
export function isIdleLockExtended(win: Window): boolean {
  try {
    return win.localStorage.getItem(IDLE_EXTENDED_KEY) === "1";
  } catch {
    // Storage blocked or unreadable — fail to the normal 10s lock.
    return false;
  }
}

/** The idle duration the unlocked chat should use right now. */
export function chatIdleLockMs(win: Window): number {
  return isIdleLockExtended(win) ? IDLE_LOCK_EXTENDED_MS : IDLE_LOCK_MS;
}

/** Ticks ("1") or unticks (key removed) the preference, then announces the
 * change on `win`. A refused write (quota / blocked storage) is swallowed —
 * callers re-read `isIdleLockExtended` to see what actually stuck. */
export function setIdleLockExtended(win: Window, extended: boolean): void {
  try {
    if (extended) win.localStorage.setItem(IDLE_EXTENDED_KEY, "1");
    else win.localStorage.removeItem(IDLE_EXTENDED_KEY);
  } catch {
    // Nothing changed in storage; the announcement below is a harmless re-read.
  }
  win.dispatchEvent(new Event(IDLE_PREFERENCE_CHANGED_EVENT));
}

/** Calls `listener` whenever the preference may have changed — in this window
 * (`setIdleLockExtended`) or, via the `storage` event, another tab of this
 * device. Returns the unsubscribe function. */
export function onIdleLockPreferenceChanged(win: Window, listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    // A null key is `localStorage.clear()` — it may have removed ours too.
    if (event.key === null || event.key === IDLE_EXTENDED_KEY) listener();
  };
  win.addEventListener(IDLE_PREFERENCE_CHANGED_EVENT, listener);
  win.addEventListener("storage", onStorage);
  return () => {
    win.removeEventListener(IDLE_PREFERENCE_CHANGED_EVENT, listener);
    win.removeEventListener("storage", onStorage);
  };
}
