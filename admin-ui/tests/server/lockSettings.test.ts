// The per-device "Lock when I change tab" / "Lock when I lock my screen" preferences and the
// "this device has proven it reports screen locks" flag (spec/server-chat/03-permanent-unlock.md
// §8). A key holds "0" when a box is UNTICKED and is otherwise absent; anything unreadable
// means ON — the fail-closed default for a disguised chat.

import { describe, expect, it, vi } from "vitest";
import {
  isScreenLockProven,
  LOCK_ON_SCREEN_KEY,
  LOCK_ON_TAB_KEY,
  LOCK_PREFS_CHANGED_EVENT,
  onLockSettingsChanged,
  readStoredLockSettings,
  SCREENLOCK_PROVEN_KEY,
  setLockSettings,
  setScreenLockProven,
} from "../../src/server/lockSettings";

interface StorageOptions {
  readonly seed?: Readonly<Record<string, string>>;
  readonly throwOnGet?: boolean;
  readonly throwOnSet?: boolean;
  readonly throwOnRemove?: boolean;
}

function fakeWindow(options: StorageOptions = {}): {
  readonly win: Window;
  readonly data: Map<string, string>;
  readonly announced: () => number;
} {
  const data = new Map<string, string>(Object.entries(options.seed ?? {}));
  const localStorage = {
    getItem(key: string): string | null {
      if (options.throwOnGet === true) throw new Error("storage unreadable");
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (options.throwOnSet === true) throw new Error("storage full");
      data.set(key, value);
    },
    removeItem(key: string): void {
      if (options.throwOnRemove === true) throw new Error("storage locked");
      data.delete(key);
    },
  };
  const target = new EventTarget();
  let announcements = 0;
  target.addEventListener(LOCK_PREFS_CHANGED_EVENT, () => {
    announcements += 1;
  });
  return { win: Object.assign(target, { localStorage }) as unknown as Window, data, announced: () => announcements };
}

describe("readStoredLockSettings", () => {
  it("defaults BOTH boxes to ticked when nothing is stored", () => {
    expect(readStoredLockSettings(fakeWindow().win)).toEqual({ lockOnTab: true, lockOnScreen: true });
  });

  it("reads '0' as unticked, per box", () => {
    expect(readStoredLockSettings(fakeWindow({ seed: { [LOCK_ON_TAB_KEY]: "0" } }).win)).toEqual({
      lockOnTab: false,
      lockOnScreen: true,
    });
    expect(readStoredLockSettings(fakeWindow({ seed: { [LOCK_ON_SCREEN_KEY]: "0" } }).win)).toEqual({
      lockOnTab: true,
      lockOnScreen: false,
    });
    expect(
      readStoredLockSettings(fakeWindow({ seed: { [LOCK_ON_TAB_KEY]: "0", [LOCK_ON_SCREEN_KEY]: "0" } }).win),
    ).toEqual({ lockOnTab: false, lockOnScreen: false });
  });

  it.each(["1", "", "false", "off", "no", " 0", "0 ", "00", "true"])(
    "reads the value %j as ticked — only an exact '0' turns a box off",
    (value) => {
      const { win } = fakeWindow({ seed: { [LOCK_ON_TAB_KEY]: value, [LOCK_ON_SCREEN_KEY]: value } });
      expect(readStoredLockSettings(win)).toEqual({ lockOnTab: true, lockOnScreen: true });
    },
  );

  it("reads unreadable storage as both ticked (fail closed)", () => {
    const { win } = fakeWindow({
      seed: { [LOCK_ON_TAB_KEY]: "0", [LOCK_ON_SCREEN_KEY]: "0" },
      throwOnGet: true,
    });
    expect(readStoredLockSettings(win)).toEqual({ lockOnTab: true, lockOnScreen: true });
  });
});

describe("setLockSettings", () => {
  it("writes '0' for an unticked box and removes the key for a ticked one", () => {
    const { win, data } = fakeWindow({ seed: { [LOCK_ON_TAB_KEY]: "0", [LOCK_ON_SCREEN_KEY]: "0" } });
    setLockSettings(win, { lockOnTab: true, lockOnScreen: false });
    expect(data.has(LOCK_ON_TAB_KEY)).toBe(false);
    expect(data.get(LOCK_ON_SCREEN_KEY)).toBe("0");
    setLockSettings(win, { lockOnTab: false, lockOnScreen: true });
    expect(data.get(LOCK_ON_TAB_KEY)).toBe("0");
    expect(data.has(LOCK_ON_SCREEN_KEY)).toBe(false);
  });

  it("round-trips through the reader and announces every write", () => {
    const { win, announced } = fakeWindow();
    setLockSettings(win, { lockOnTab: false, lockOnScreen: true });
    expect(readStoredLockSettings(win)).toEqual({ lockOnTab: false, lockOnScreen: true });
    setLockSettings(win, { lockOnTab: false, lockOnScreen: false });
    expect(readStoredLockSettings(win)).toEqual({ lockOnTab: false, lockOnScreen: false });
    setLockSettings(win, { lockOnTab: true, lockOnScreen: true });
    expect(readStoredLockSettings(win)).toEqual({ lockOnTab: true, lockOnScreen: true });
    expect(announced()).toBe(3);
  });

  it("swallows a refused write, announces anyway, and the reader shows what really stuck", () => {
    const { win, announced } = fakeWindow({ throwOnSet: true });
    expect(() => setLockSettings(win, { lockOnTab: false, lockOnScreen: false })).not.toThrow();
    expect(announced()).toBe(1);
    expect(readStoredLockSettings(win)).toEqual({ lockOnTab: true, lockOnScreen: true });
  });

  it("swallows a refused removal too", () => {
    const { win } = fakeWindow({ seed: { [LOCK_ON_TAB_KEY]: "0" }, throwOnRemove: true });
    expect(() => setLockSettings(win, { lockOnTab: true, lockOnScreen: true })).not.toThrow();
  });
});

describe("the screen-lock proof flag", () => {
  it("is unproven by default and only exactly '1' counts as proven", () => {
    expect(isScreenLockProven(fakeWindow().win)).toBe(false);
    expect(isScreenLockProven(fakeWindow({ seed: { [SCREENLOCK_PROVEN_KEY]: "1" } }).win)).toBe(true);
    for (const other of ["0", "", "true", "yes", "2", " 1"]) {
      expect(isScreenLockProven(fakeWindow({ seed: { [SCREENLOCK_PROVEN_KEY]: other } }).win)).toBe(false);
    }
  });

  it("reads unreadable storage as unproven (fail closed)", () => {
    expect(isScreenLockProven(fakeWindow({ seed: { [SCREENLOCK_PROVEN_KEY]: "1" }, throwOnGet: true }).win)).toBe(
      false,
    );
  });

  it("is set with '1', cleared by removing the key, and announces each change", () => {
    const { win, data, announced } = fakeWindow();
    setScreenLockProven(win, true);
    expect(data.get(SCREENLOCK_PROVEN_KEY)).toBe("1");
    expect(isScreenLockProven(win)).toBe(true);
    setScreenLockProven(win, false);
    expect(data.has(SCREENLOCK_PROVEN_KEY)).toBe(false);
    expect(isScreenLockProven(win)).toBe(false);
    expect(announced()).toBe(2);
  });

  it("never throws when storage refuses, and unwritable storage stays unproven", () => {
    const { win, announced } = fakeWindow({ throwOnSet: true, throwOnRemove: true });
    expect(() => setScreenLockProven(win, true)).not.toThrow();
    expect(() => setScreenLockProven(win, false)).not.toThrow();
    expect(isScreenLockProven(win)).toBe(false);
    // The refused "prove" was an attempted change and is announced; clearing what is already
    // clear is not a change.
    expect(announced()).toBe(1);
  });

  it("announces ONLY a real change — the panel restarts its detector on every announcement, so a detector that keeps failing (and keeps clearing the flag) must not restart itself forever", () => {
    const { win, announced } = fakeWindow();
    setScreenLockProven(win, false); // already clear
    setScreenLockProven(win, false);
    expect(announced()).toBe(0);
    setScreenLockProven(win, true);
    setScreenLockProven(win, true); // already proven
    expect(announced()).toBe(1);
    setScreenLockProven(win, false);
    setScreenLockProven(win, false);
    expect(announced()).toBe(2);
  });

  it("is independent of the two boxes", () => {
    const { win } = fakeWindow();
    setScreenLockProven(win, true);
    expect(readStoredLockSettings(win)).toEqual({ lockOnTab: true, lockOnScreen: true });
    setLockSettings(win, { lockOnTab: false, lockOnScreen: false });
    expect(isScreenLockProven(win)).toBe(true);
  });
});

describe("onLockSettingsChanged", () => {
  function storageEvent(key: string | null): Event {
    return Object.assign(new Event("storage"), { key });
  }

  it("fires for this window's own writes and stops after unsubscribe", () => {
    const { win } = fakeWindow();
    const listener = vi.fn();
    const off = onLockSettingsChanged(win, listener);
    setLockSettings(win, { lockOnTab: false, lockOnScreen: true });
    setScreenLockProven(win, true);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    setLockSettings(win, { lockOnTab: true, lockOnScreen: true });
    win.dispatchEvent(storageEvent(LOCK_ON_TAB_KEY));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("fires for another tab changing either box, the proof flag, or clearing the store", () => {
    const { win } = fakeWindow();
    const listener = vi.fn();
    onLockSettingsChanged(win, listener);
    win.dispatchEvent(storageEvent(LOCK_ON_TAB_KEY));
    win.dispatchEvent(storageEvent(LOCK_ON_SCREEN_KEY));
    win.dispatchEvent(storageEvent(SCREENLOCK_PROVEN_KEY));
    win.dispatchEvent(storageEvent(null));
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("ignores an unrelated key", () => {
    const { win } = fakeWindow();
    const listener = vi.fn();
    onLockSettingsChanged(win, listener);
    win.dispatchEvent(storageEvent("wx-srv-idle-extended"));
    win.dispatchEvent(storageEvent("wx-srv-device-grant"));
    expect(listener).not.toHaveBeenCalled();
  });

  it("uses distinct storage keys for the three values", () => {
    expect(new Set([LOCK_ON_TAB_KEY, LOCK_ON_SCREEN_KEY, SCREENLOCK_PROVEN_KEY]).size).toBe(3);
    expect(LOCK_ON_TAB_KEY).toBe("wx-srv-lock-on-tab");
    expect(LOCK_ON_SCREEN_KEY).toBe("wx-srv-lock-on-screen");
    expect(SCREENLOCK_PROVEN_KEY).toBe("wx-srv-screenlock-proven");
  });
});
