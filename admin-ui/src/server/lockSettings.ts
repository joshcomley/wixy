// The per-device "Lock when I change tab" / "Lock when I lock my screen" preferences
// (spec/server-chat/03-permanent-unlock.md §8), plus the flag that records whether this
// device has ever proven it can report a screen lock. Like the "Extend auto-lock" box
// (`idlePreference.ts`) they live in this browser's localStorage only and are changed from
// inside the unlocked chat's settings sheet.
//
// Storage contract: a key holds "0" when the box is UNTICKED and is otherwise absent.
// Absent, unreadable or any other value means ON — the fail-closed default (the chat is
// disguised, so a background switch locks it unless the owner said not to).

import type { LockSettings } from "./lockModel";

export const LOCK_ON_TAB_KEY = "wx-srv-lock-on-tab";
export const LOCK_ON_SCREEN_KEY = "wx-srv-lock-on-screen";
export const SCREENLOCK_PROVEN_KEY = "wx-srv-screenlock-proven";
export const LOCK_PREFS_CHANGED_EVENT = "wx-srv-lock-prefs-changed";

function readFlagOn(win: Window, key: string): boolean {
  try {
    return win.localStorage.getItem(key) !== "0";
  } catch {
    return true;
  }
}

function writeFlag(win: Window, key: string, on: boolean): void {
  try {
    if (on) win.localStorage.removeItem(key);
    else win.localStorage.setItem(key, "0");
  } catch {
    // A refused write changes nothing; callers re-read to see what stuck.
  }
}

/** What is stored, before the browser's ability to tell the two apart is taken into account
 * (`effectiveLockSettings` in lockModel.ts does that). */
export function readStoredLockSettings(win: Window): LockSettings {
  return { lockOnTab: readFlagOn(win, LOCK_ON_TAB_KEY), lockOnScreen: readFlagOn(win, LOCK_ON_SCREEN_KEY) };
}

/** Writes both boxes at once and announces the change — used when the two follow each
 * other because this browser cannot tell a screen lock from a tab switch. */
export function setLockSettings(win: Window, settings: LockSettings): void {
  writeFlag(win, LOCK_ON_TAB_KEY, settings.lockOnTab);
  writeFlag(win, LOCK_ON_SCREEN_KEY, settings.lockOnScreen);
  win.dispatchEvent(new Event(LOCK_PREFS_CHANGED_EVENT));
}

/** True only when the stored value is exactly "1". */
export function isScreenLockProven(win: Window): boolean {
  try {
    return win.localStorage.getItem(SCREENLOCK_PROVEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** Sets or clears the proof that this device delivers screen-lock events across a hide and
 * return. Unwritable storage leaves it unproven, which fails closed. Announces ONLY when the
 * value really changes: the panel restarts its detector on these announcements, and a detector
 * that keeps failing clears the proof every time — an announcement per failure would restart it
 * forever. */
export function setScreenLockProven(win: Window, proven: boolean): void {
  if (isScreenLockProven(win) === proven) return;
  try {
    if (proven) win.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
    else win.localStorage.removeItem(SCREENLOCK_PROVEN_KEY);
  } catch {
    // Unproven is the safe reading.
  }
  win.dispatchEvent(new Event(LOCK_PREFS_CHANGED_EVENT));
}

/** Calls `listener` whenever any of these values may have changed — in this window, or (via
 * the `storage` event) another tab of this device. Returns the unsubscribe function. */
export function onLockSettingsChanged(win: Window, listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (
      event.key === null ||
      event.key === LOCK_ON_TAB_KEY ||
      event.key === LOCK_ON_SCREEN_KEY ||
      event.key === SCREENLOCK_PROVEN_KEY
    ) {
      listener();
    }
  };
  win.addEventListener(LOCK_PREFS_CHANGED_EVENT, listener);
  win.addEventListener("storage", onStorage);
  return () => {
    win.removeEventListener(LOCK_PREFS_CHANGED_EVENT, listener);
    win.removeEventListener("storage", onStorage);
  };
}
