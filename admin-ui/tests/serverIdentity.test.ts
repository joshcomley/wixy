import { describe, expect, it } from "vitest";
import { createServerIdentity } from "../src/server/identity";

function fakeWindow(): Window {
  const store = new Map<string, string>();
  return {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    },
    crypto: { randomUUID: () => "device-uuid-1" },
  } as unknown as Window;
}

describe("createServerIdentity", () => {
  it("has no name before it's ever been set", () => {
    const identity = createServerIdentity(fakeWindow());
    expect(identity.getName()).toBeNull();
  });

  it("setName trims and persists; getName reads it back", () => {
    const identity = createServerIdentity(fakeWindow());
    identity.setName("  Josh  ");
    expect(identity.getName()).toBe("Josh");
  });

  it("setName clamps to 32 characters", () => {
    const identity = createServerIdentity(fakeWindow());
    identity.setName("x".repeat(50));
    expect(identity.getName()).toHaveLength(32);
  });

  it("setName is a no-op for a blank (or whitespace-only) name", () => {
    const identity = createServerIdentity(fakeWindow());
    identity.setName("   ");
    expect(identity.getName()).toBeNull();
  });

  it("getDeviceId mints once and persists across calls", () => {
    const win = fakeWindow();
    const identity = createServerIdentity(win);
    const first = identity.getDeviceId();
    expect(first).toBe("device-uuid-1");
    const second = createServerIdentity(win).getDeviceId();
    expect(second).toBe(first);
  });

  it("isMine matches the saved name case-insensitively", () => {
    const identity = createServerIdentity(fakeWindow());
    identity.setName("Purdy");
    expect(identity.isMine("purdy")).toBe(true);
    expect(identity.isMine("PURDY")).toBe(true);
    expect(identity.isMine("Josh")).toBe(false);
  });

  it("isMine is false when no name has been set yet", () => {
    const identity = createServerIdentity(fakeWindow());
    expect(identity.isMine("anyone")).toBe(false);
  });
});
