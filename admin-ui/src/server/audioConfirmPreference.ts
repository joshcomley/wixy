// The per-device "Ask before playing audio messages" preference. Stored in
// this browser's localStorage only (like idlePreference.ts) — nothing about
// it is ever sent to the server — and it can only be changed from inside the
// unlocked chat's settings sheet.
//
// Storage contract: the key holds "1" when ticked and is ABSENT otherwise.
// Absent, unreadable (storage blocked / throws) or any other value means OFF,
// preserving today's default behavior where tapping play immediately plays.

export const AUDIO_CONFIRM_KEY = "wx-srv-audio-confirm";
export const AUDIO_CONFIRM_CHANGED_EVENT = "wx-srv-audio-confirm-changed";

/** `true` only when the stored value is exactly "1". Default OFF. */
export function isAudioConfirmEnabled(win: Window): boolean {
  try {
    return win.localStorage.getItem(AUDIO_CONFIRM_KEY) === "1";
  } catch {
    // Storage blocked or unreadable — fail to default OFF.
    return false;
  }
}

/** Ticks ("1") or unticks (key removed) the preference, then announces on `win`. */
export function setAudioConfirmEnabled(win: Window, enabled: boolean): void {
  try {
    if (enabled) win.localStorage.setItem(AUDIO_CONFIRM_KEY, "1");
    else win.localStorage.removeItem(AUDIO_CONFIRM_KEY);
  } catch {
    // Swallowed
  }
  win.dispatchEvent(new Event(AUDIO_CONFIRM_CHANGED_EVENT));
}

/** Calls `listener` whenever the preference may have changed in this or another tab. */
export function onAudioConfirmPreferenceChanged(win: Window, listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === AUDIO_CONFIRM_KEY) listener();
  };
  win.addEventListener(AUDIO_CONFIRM_CHANGED_EVENT, listener);
  win.addEventListener("storage", onStorage);
  return () => {
    win.removeEventListener(AUDIO_CONFIRM_CHANGED_EVENT, listener);
    win.removeEventListener("storage", onStorage);
  };
}
