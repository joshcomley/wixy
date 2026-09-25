// The per-device "Keep this device unlocked" state (spec/server-chat/03-permanent-unlock.md
// §4): two localStorage keys, and every failure mode reads as OFF — never as something looser.

import { describe, expect, it, vi } from "vitest";
import {
  clearDeviceGrant,
  DEVICE_GRANT_KEY,
  deviceLabel,
  GRANT_PAUSED_KEY,
  GRANT_STATE_CHANGED_EVENT,
  isDeviceGrantPaused,
  isGrantActive,
  onGrantStateChanged,
  readDeviceGrant,
  setGrantPaused,
  storeDeviceGrant,
  type StoredDeviceGrant,
} from "../../src/server/deviceGrant";

const GRANT: StoredDeviceGrant = { grantId: "0123456789abcdef0123456789abcdef", secret: "A".repeat(43) };

interface StorageOptions {
  readonly seed?: Readonly<Record<string, string>>;
  readonly throwOnGet?: (key: string) => boolean;
  readonly throwOnSet?: (key: string) => boolean;
  readonly throwOnRemove?: (key: string) => boolean;
}

/** A window whose localStorage can be told to fail, so each "storage is broken" branch runs. */
function fakeWindow(options: StorageOptions = {}): {
  readonly win: Window;
  readonly data: Map<string, string>;
  readonly events: string[];
} {
  const data = new Map<string, string>(Object.entries(options.seed ?? {}));
  const localStorage = {
    getItem(key: string): string | null {
      if (options.throwOnGet?.(key) === true) throw new Error("storage unreadable");
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (options.throwOnSet?.(key) === true) throw new Error("storage full");
      data.set(key, value);
    },
    removeItem(key: string): void {
      if (options.throwOnRemove?.(key) === true) throw new Error("storage locked");
      data.delete(key);
    },
  };
  const target = new EventTarget();
  const events: string[] = [];
  const win = Object.assign(target, { localStorage, navigator: { userAgent: "" } }) as unknown as Window;
  target.addEventListener(GRANT_STATE_CHANGED_EVENT, () => events.push(GRANT_STATE_CHANGED_EVENT));
  return { win, data, events };
}

function withGrant(extra: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
  return { [DEVICE_GRANT_KEY]: JSON.stringify(GRANT), ...extra };
}

describe("readDeviceGrant", () => {
  it("reads back a well-formed grant", () => {
    const { win } = fakeWindow({ seed: withGrant() });
    expect(readDeviceGrant(win)).toEqual(GRANT);
  });

  it("is off when nothing is stored", () => {
    expect(readDeviceGrant(fakeWindow().win)).toBeNull();
  });

  it("ignores extra fields and returns only the two it knows", () => {
    const { win } = fakeWindow({
      seed: { [DEVICE_GRANT_KEY]: JSON.stringify({ ...GRANT, admin: true, extra: 1 }) },
    });
    expect(readDeviceGrant(win)).toEqual(GRANT);
  });

  it.each([
    ["not JSON", "{not json"],
    ["truncated JSON", '{"grantId": "0123456789abcdef0123456789abcdef", "secret": "AAAA'],
    ["an empty string", ""],
    ["a JSON string", '"just a string"'],
    ["a JSON number", "42"],
    ["JSON null", "null"],
    ["a JSON array", "[]"],
    ["an empty object", "{}"],
    ["a missing secret", JSON.stringify({ grantId: GRANT.grantId })],
    ["a missing grantId", JSON.stringify({ secret: GRANT.secret })],
    ["a numeric grantId", JSON.stringify({ grantId: 12345, secret: GRANT.secret })],
    ["a numeric secret", JSON.stringify({ grantId: GRANT.grantId, secret: 12345 })],
    ["an upper-case grantId", JSON.stringify({ ...GRANT, grantId: GRANT.grantId.toUpperCase() })],
    ["a non-hex grantId", JSON.stringify({ ...GRANT, grantId: "z".repeat(32) })],
    ["a short grantId", JSON.stringify({ ...GRANT, grantId: "abc" })],
    ["a long grantId", JSON.stringify({ ...GRANT, grantId: "a".repeat(33) })],
    ["a grantId with a newline", JSON.stringify({ ...GRANT, grantId: `${"a".repeat(31)}\n` })],
    ["a short secret", JSON.stringify({ ...GRANT, secret: "A".repeat(42) })],
    ["a long secret", JSON.stringify({ ...GRANT, secret: "A".repeat(44) })],
    ["a padded secret", JSON.stringify({ ...GRANT, secret: `${"A".repeat(43)}=` })],
    ["standard-base64 characters", JSON.stringify({ ...GRANT, secret: `${"A".repeat(42)}+` })],
    ["a secret with a slash", JSON.stringify({ ...GRANT, secret: `${"A".repeat(42)}/` })],
    ["a secret with whitespace", JSON.stringify({ ...GRANT, secret: `${"A".repeat(42)} ` })],
    ["a secret with a newline", JSON.stringify({ ...GRANT, secret: `${"A".repeat(42)}\n` })],
  ])("reads %s as off, never sending a tampered value anywhere", (_name, raw) => {
    const { win } = fakeWindow({ seed: { [DEVICE_GRANT_KEY]: raw } });
    expect(readDeviceGrant(win)).toBeNull();
    expect(isGrantActive(win)).toBe(false);
  });

  it("accepts every base64url character in the secret", () => {
    const secret = `${"abcXYZ019-_".repeat(4)}abcd`.slice(0, 43);
    expect(secret).toHaveLength(43);
    const { win } = fakeWindow({ seed: { [DEVICE_GRANT_KEY]: JSON.stringify({ ...GRANT, secret }) } });
    expect(readDeviceGrant(win)?.secret).toBe(secret);
  });

  it("reads unreadable storage as off", () => {
    const { win } = fakeWindow({ seed: withGrant(), throwOnGet: () => true });
    expect(readDeviceGrant(win)).toBeNull();
    expect(isGrantActive(win)).toBe(false);
  });
});

describe("isDeviceGrantPaused / isGrantActive", () => {
  it("is not paused unless the key is exactly '1'", () => {
    expect(isDeviceGrantPaused(fakeWindow().win)).toBe(false);
    expect(isDeviceGrantPaused(fakeWindow({ seed: { [GRANT_PAUSED_KEY]: "1" } }).win)).toBe(true);
    for (const other of ["0", "", "true", "yes", " 1"]) {
      expect(isDeviceGrantPaused(fakeWindow({ seed: { [GRANT_PAUSED_KEY]: other } }).win)).toBe(false);
    }
  });

  it("reads a pause it cannot read as PAUSED — the direction that asks for the PIN", () => {
    const { win } = fakeWindow({ throwOnGet: (key) => key === GRANT_PAUSED_KEY });
    expect(isDeviceGrantPaused(win)).toBe(true);
  });

  it("is active only with a grant that is not paused", () => {
    expect(isGrantActive(fakeWindow().win)).toBe(false);
    expect(isGrantActive(fakeWindow({ seed: withGrant() }).win)).toBe(true);
    expect(isGrantActive(fakeWindow({ seed: withGrant({ [GRANT_PAUSED_KEY]: "1" }) }).win)).toBe(false);
    expect(isGrantActive(fakeWindow({ seed: { [GRANT_PAUSED_KEY]: "0" } }).win)).toBe(false);
  });

  it("a grant whose pause key cannot be read is not active", () => {
    const { win } = fakeWindow({ seed: withGrant(), throwOnGet: (key) => key === GRANT_PAUSED_KEY });
    expect(readDeviceGrant(win)).toEqual(GRANT);
    expect(isGrantActive(win)).toBe(false);
  });
});

describe("storeDeviceGrant", () => {
  it("stores exactly the two fields, clears a pause, announces, and reports that it stuck", () => {
    const { win, data, events } = fakeWindow({ seed: { [GRANT_PAUSED_KEY]: "1" } });
    expect(storeDeviceGrant(win, { ...GRANT, ...{ extra: "ignored" } } as StoredDeviceGrant)).toBe(true);
    expect(JSON.parse(data.get(DEVICE_GRANT_KEY) ?? "null")).toEqual(GRANT);
    expect(data.has(GRANT_PAUSED_KEY)).toBe(false);
    expect(events).toEqual([GRANT_STATE_CHANGED_EVENT]);
    expect(isGrantActive(win)).toBe(true);
  });

  it("reports failure honestly when the browser refuses the write — and still announces", () => {
    const { win, data, events } = fakeWindow({ throwOnSet: () => true });
    expect(storeDeviceGrant(win, GRANT)).toBe(false);
    expect(data.size).toBe(0);
    expect(readDeviceGrant(win)).toBeNull();
    expect(events).toEqual([GRANT_STATE_CHANGED_EVENT]);
  });

  it("does not mistake an OLDER grant that is still stored for the one it was asked to store", () => {
    const older: StoredDeviceGrant = { grantId: "f".repeat(32), secret: "B".repeat(43) };
    const { win } = fakeWindow({
      seed: { [DEVICE_GRANT_KEY]: JSON.stringify(older) },
      throwOnSet: () => true,
    });
    expect(storeDeviceGrant(win, GRANT)).toBe(false);
    expect(readDeviceGrant(win)).toEqual(older);
  });

  it("replaces an older grant when the write works", () => {
    const older: StoredDeviceGrant = { grantId: "f".repeat(32), secret: "B".repeat(43) };
    const { win } = fakeWindow({ seed: { [DEVICE_GRANT_KEY]: JSON.stringify(older) } });
    expect(storeDeviceGrant(win, GRANT)).toBe(true);
    expect(readDeviceGrant(win)).toEqual(GRANT);
  });

  it("reports failure when what was written cannot be read back (a tampering or lossy store)", () => {
    const { win } = fakeWindow({ throwOnGet: (key) => key === DEVICE_GRANT_KEY });
    expect(storeDeviceGrant(win, GRANT)).toBe(false);
  });

  it("does not throw when clearing the pause fails after the grant was written", () => {
    const { win } = fakeWindow({ throwOnRemove: () => true });
    expect(() => storeDeviceGrant(win, GRANT)).not.toThrow();
  });
});

describe("clearDeviceGrant", () => {
  it("removes both keys and announces", () => {
    const { win, data, events } = fakeWindow({ seed: withGrant({ [GRANT_PAUSED_KEY]: "1" }) });
    clearDeviceGrant(win);
    expect(data.size).toBe(0);
    expect(events).toEqual([GRANT_STATE_CHANGED_EVENT]);
  });

  it("is harmless when there is nothing to clear", () => {
    const { win, events } = fakeWindow();
    clearDeviceGrant(win);
    expect(events).toEqual([GRANT_STATE_CHANGED_EVENT]);
  });

  it("never throws when storage refuses the removal, and still announces", () => {
    const { win, events } = fakeWindow({ seed: withGrant(), throwOnRemove: () => true });
    expect(() => clearDeviceGrant(win)).not.toThrow();
    expect(events).toEqual([GRANT_STATE_CHANGED_EVENT]);
  });
});

describe("setGrantPaused", () => {
  it("pauses with '1' and resumes by removing the key, announcing each time", () => {
    const { win, data, events } = fakeWindow({ seed: withGrant() });
    setGrantPaused(win, true);
    expect(data.get(GRANT_PAUSED_KEY)).toBe("1");
    expect(isGrantActive(win)).toBe(false);
    setGrantPaused(win, false);
    expect(data.has(GRANT_PAUSED_KEY)).toBe(false);
    expect(isGrantActive(win)).toBe(true);
    expect(events).toEqual([GRANT_STATE_CHANGED_EVENT, GRANT_STATE_CHANGED_EVENT]);
    expect(readDeviceGrant(win)).toEqual(GRANT);
  });

  it("DROPS THE GRANT when a pause cannot be written — an unwritable pause would let a reload undo a panic", () => {
    const { win, data } = fakeWindow({ seed: withGrant(), throwOnSet: (key) => key === GRANT_PAUSED_KEY });
    setGrantPaused(win, true);
    expect(data.has(DEVICE_GRANT_KEY)).toBe(false);
    expect(readDeviceGrant(win)).toBeNull();
    expect(isGrantActive(win)).toBe(false);
  });

  it("does not throw when the pause AND the grant removal both fail (storage is dead)", () => {
    const { win, events } = fakeWindow({ seed: withGrant(), throwOnSet: () => true, throwOnRemove: () => true });
    expect(() => setGrantPaused(win, true)).not.toThrow();
    expect(events).toEqual([GRANT_STATE_CHANGED_EVENT]);
  });

  it("resuming never touches the grant, even when the removal fails", () => {
    const { win, data } = fakeWindow({
      seed: withGrant({ [GRANT_PAUSED_KEY]: "1" }),
      throwOnRemove: (key) => key === GRANT_PAUSED_KEY,
    });
    expect(() => setGrantPaused(win, false)).not.toThrow();
    expect(data.has(DEVICE_GRANT_KEY)).toBe(true);
  });
});

describe("onGrantStateChanged", () => {
  function storageEvent(key: string | null): Event {
    return Object.assign(new Event("storage"), { key });
  }

  it("fires for the in-window announcement and stops after unsubscribe", () => {
    const { win } = fakeWindow();
    const listener = vi.fn();
    const off = onGrantStateChanged(win, listener);
    win.dispatchEvent(new Event(GRANT_STATE_CHANGED_EVENT));
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    win.dispatchEvent(new Event(GRANT_STATE_CHANGED_EVENT));
    win.dispatchEvent(storageEvent(DEVICE_GRANT_KEY));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fires for another tab changing the grant, the pause, or clearing the whole store", () => {
    const { win } = fakeWindow();
    const listener = vi.fn();
    onGrantStateChanged(win, listener);
    win.dispatchEvent(storageEvent(DEVICE_GRANT_KEY));
    win.dispatchEvent(storageEvent(GRANT_PAUSED_KEY));
    win.dispatchEvent(storageEvent(null));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("ignores an unrelated key", () => {
    const { win } = fakeWindow();
    const listener = vi.fn();
    onGrantStateChanged(win, listener);
    win.dispatchEvent(storageEvent("wx-srv-name"));
    win.dispatchEvent(storageEvent("wx-srv-idle-extended"));
    expect(listener).not.toHaveBeenCalled();
  });

  it("is driven by the real store/clear/pause functions", () => {
    const { win } = fakeWindow();
    const listener = vi.fn();
    onGrantStateChanged(win, listener);
    storeDeviceGrant(win, GRANT);
    setGrantPaused(win, true);
    setGrantPaused(win, false);
    clearDeviceGrant(win);
    expect(listener).toHaveBeenCalledTimes(4);
  });
});

describe("deviceLabel", () => {
  function labelFor(userAgent: string): string {
    const { win } = fakeWindow();
    return deviceLabel(Object.assign(win, { navigator: { userAgent } }));
  }

  it.each([
    [
      "Android Chrome",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
      "Android · Chrome",
    ],
    [
      "Android Firefox",
      "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0",
      "Android · Firefox",
    ],
    [
      "iPhone Safari",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      "iOS · Safari",
    ],
    [
      "iPhone Chrome",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1",
      "iOS · Chrome",
    ],
    [
      "Windows Edge",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
      "Windows · Edge",
    ],
    [
      "Windows Chrome",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Windows · Chrome",
    ],
    [
      "Windows Firefox",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
      "Windows · Firefox",
    ],
    [
      "Mac Safari",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
      "Mac · Safari",
    ],
    [
      "ChromeOS Chrome",
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "ChromeOS · Chrome",
    ],
    [
      "Linux Firefox",
      "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
      "Linux · Firefox",
    ],
    ["an unknown agent", "SomethingElse/1.0", "Device · Browser"],
    ["an empty agent", "", "Device · Browser"],
  ])("names %s", (_name, userAgent, expected) => {
    expect(labelFor(userAgent)).toBe(expected);
  });

  it("never exceeds the server's 80-character label limit", () => {
    expect(labelFor("Android ".repeat(500)).length).toBeLessThanOrEqual(80);
  });
});
