import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_CONFIRM_CHANGED_EVENT,
  AUDIO_CONFIRM_KEY,
  isAudioConfirmEnabled,
  onAudioConfirmPreferenceChanged,
  setAudioConfirmEnabled,
} from "../../src/server/audioConfirmPreference";

describe("audioConfirmPreference storage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("uses the agreed localStorage key", () => {
    expect(AUDIO_CONFIRM_KEY).toBe("wx-srv-audio-confirm");
  });

  it("is OFF when the key is absent (the default)", () => {
    expect(isAudioConfirmEnabled(window)).toBe(false);
  });

  it("is ON only for the exact value '1'", () => {
    window.localStorage.setItem(AUDIO_CONFIRM_KEY, "1");
    expect(isAudioConfirmEnabled(window)).toBe(true);
  });

  it.each(["0", "true", "yes", "", " 1", "1 ", "2", "on"])("any other value (%j) is OFF", (value) => {
    window.localStorage.setItem(AUDIO_CONFIRM_KEY, value);
    expect(isAudioConfirmEnabled(window)).toBe(false);
  });

  it("an unreadable store (getItem throws) is OFF, never an exception", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(isAudioConfirmEnabled(window)).toBe(false);
  });

  it("ticking writes '1'; unticking REMOVES the key", () => {
    setAudioConfirmEnabled(window, true);
    expect(window.localStorage.getItem(AUDIO_CONFIRM_KEY)).toBe("1");
    setAudioConfirmEnabled(window, false);
    expect(window.localStorage.getItem(AUDIO_CONFIRM_KEY)).toBeNull();
  });

  it("a refused write is swallowed gracefully", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(() => setAudioConfirmEnabled(window, true)).not.toThrow();
    expect(isAudioConfirmEnabled(window)).toBe(false);
  });
});

describe("onAudioConfirmPreferenceChanged", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("fires when this window's setting changes, and stops after unsubscribe", () => {
    const listener = vi.fn();
    const off = onAudioConfirmPreferenceChanged(window, listener);
    setAudioConfirmEnabled(window, true);
    expect(listener).toHaveBeenCalledTimes(1);
    setAudioConfirmEnabled(window, false);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    setAudioConfirmEnabled(window, true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("the change event is the module's own named event on the window", () => {
    const listener = vi.fn();
    window.addEventListener(AUDIO_CONFIRM_CHANGED_EVENT, listener);
    setAudioConfirmEnabled(window, true);
    window.removeEventListener(AUDIO_CONFIRM_CHANGED_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fires for another tab's change to THIS key (storage event), ignores other keys", () => {
    const listener = vi.fn();
    const off = onAudioConfirmPreferenceChanged(window, listener);
    window.dispatchEvent(new StorageEvent("storage", { key: "wx-srv-other", newValue: "1" }));
    expect(listener).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent("storage", { key: AUDIO_CONFIRM_KEY, newValue: "1" }));
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it("fires when storage is cleared wholesale (storage event with a null key)", () => {
    const listener = vi.fn();
    const off = onAudioConfirmPreferenceChanged(window, listener);
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});
