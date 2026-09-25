// The per-device "Extend auto-lock to 1 minute" preference (Architect ruling):
// localStorage key `wx-srv-idle-extended` holds "1" when ticked and is ABSENT
// otherwise; absent, unreadable or any other value means OFF. Nothing here
// ever reaches the server.

import { afterEach, describe, expect, it, vi } from "vitest";
import { IDLE_LOCK_EXTENDED_MS, IDLE_LOCK_MS } from "../../src/server/constants";
import {
  chatIdleLockMs,
  IDLE_EXTENDED_KEY,
  IDLE_PREFERENCE_CHANGED_EVENT,
  isIdleLockExtended,
  onIdleLockPreferenceChanged,
  setIdleLockExtended,
} from "../../src/server/idlePreference";

describe("idle-lock preference storage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("uses the agreed localStorage key", () => {
    expect(IDLE_EXTENDED_KEY).toBe("wx-srv-idle-extended");
  });

  it("is OFF when the key is absent (the default)", () => {
    expect(isIdleLockExtended(window)).toBe(false);
    expect(chatIdleLockMs(window)).toBe(IDLE_LOCK_MS);
  });

  it("is ON only for the exact value '1'", () => {
    window.localStorage.setItem(IDLE_EXTENDED_KEY, "1");
    expect(isIdleLockExtended(window)).toBe(true);
    expect(chatIdleLockMs(window)).toBe(IDLE_LOCK_EXTENDED_MS);
  });

  it.each(["0", "true", "yes", "", " 1", "1 ", "2", "on"])("any other value (%j) is OFF", (value) => {
    window.localStorage.setItem(IDLE_EXTENDED_KEY, value);
    expect(isIdleLockExtended(window)).toBe(false);
    expect(chatIdleLockMs(window)).toBe(IDLE_LOCK_MS);
  });

  it("an unreadable store (getItem throws) is OFF, never an exception", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(isIdleLockExtended(window)).toBe(false);
    expect(chatIdleLockMs(window)).toBe(IDLE_LOCK_MS);
  });

  it("an inaccessible localStorage property is OFF, never an exception", () => {
    const hostile = {
      get localStorage(): Storage {
        throw new DOMException("blocked", "SecurityError");
      },
    } as unknown as Window;
    expect(isIdleLockExtended(hostile)).toBe(false);
  });

  it("ticking writes '1'; unticking REMOVES the key (nothing stale left behind)", () => {
    setIdleLockExtended(window, true);
    expect(window.localStorage.getItem(IDLE_EXTENDED_KEY)).toBe("1");
    setIdleLockExtended(window, false);
    expect(window.localStorage.getItem(IDLE_EXTENDED_KEY)).toBeNull();
    expect(Object.keys(window.localStorage)).not.toContain(IDLE_EXTENDED_KEY);
  });

  it("a refused write (quota / blocked) is swallowed and the stored value stays as it was", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(() => setIdleLockExtended(window, true)).not.toThrow();
    expect(isIdleLockExtended(window)).toBe(false);
  });

  it("a refused removal is swallowed too", () => {
    window.localStorage.setItem(IDLE_EXTENDED_KEY, "1");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() => setIdleLockExtended(window, false)).not.toThrow();
    expect(isIdleLockExtended(window)).toBe(true);
  });
});

describe("onIdleLockPreferenceChanged", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("fires when this window's own setting changes, and stops after unsubscribe", () => {
    const listener = vi.fn();
    const off = onIdleLockPreferenceChanged(window, listener);
    setIdleLockExtended(window, true);
    expect(listener).toHaveBeenCalledTimes(1);
    setIdleLockExtended(window, false);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    setIdleLockExtended(window, true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("the change event is the module's own named event on the window", () => {
    const listener = vi.fn();
    window.addEventListener(IDLE_PREFERENCE_CHANGED_EVENT, listener);
    setIdleLockExtended(window, true);
    window.removeEventListener(IDLE_PREFERENCE_CHANGED_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fires for another tab's change to THIS key (storage event), ignores other keys", () => {
    const listener = vi.fn();
    const off = onIdleLockPreferenceChanged(window, listener);
    window.dispatchEvent(new StorageEvent("storage", { key: "wx-srv-name", newValue: "Josh" }));
    expect(listener).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent("storage", { key: IDLE_EXTENDED_KEY, newValue: "1" }));
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    window.dispatchEvent(new StorageEvent("storage", { key: IDLE_EXTENDED_KEY, newValue: null }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fires when storage is cleared wholesale (storage event with a null key)", () => {
    const listener = vi.fn();
    const off = onIdleLockPreferenceChanged(window, listener);
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});
