import { describe, expect, it } from "vitest";
import { BANKED_KEY, REJECTED_KEY, SETTINGS_KEY, createMemory, type BankedEntry } from "../../src/public/memory";
import { fakeStorage } from "./publicFixtures";

const LISBON: BankedEntry = { code: "aaaaa1", destinationId: "AAA.a1", unitId: "AAA", at: 1_800_000_000 };
const PORTO: BankedEntry = { code: "aaaaa3", destinationId: "AAA.a3", unitId: "AAA", at: 1_800_000_100 };

describe("memory: the happy path", () => {
  it("starts empty", () => {
    const m = createMemory(() => fakeStorage());
    expect(m.banked()).toEqual([]);
    expect([...m.rejected()]).toEqual([]);
    expect(m.includeAdvised()).toBe(false);
    expect(m.persistent).toBe(true);
  });

  it("banks and rejects, newest bank first, and writes the three documented keys", () => {
    const storage = fakeStorage();
    const m = createMemory(() => storage);
    m.bank(LISBON);
    m.bank(PORTO);
    m.reject("AAA.a5");
    m.setIncludeAdvised(true);
    expect(m.banked().map((e) => e.destinationId)).toEqual(["AAA.a3", "AAA.a1"]);
    expect([...m.rejected()]).toEqual(["AAA.a5"]);
    expect([...m.taken()].sort()).toEqual(["AAA.a1", "AAA.a3", "AAA.a5"]);
    expect(m.includeAdvised()).toBe(true);
    expect(JSON.parse(storage.getItem(BANKED_KEY) as string)).toEqual([LISBON, PORTO]);
    expect(JSON.parse(storage.getItem(REJECTED_KEY) as string)).toEqual(["AAA.a5"]);
    expect(JSON.parse(storage.getItem(SETTINGS_KEY) as string)).toEqual({ includeAdvised: true });
    expect(BANKED_KEY).toBe("advPublic.v1.banked");
    expect(REJECTED_KEY).toBe("advPublic.v1.rejected");
    expect(SETTINGS_KEY).toBe("advPublic.v1.settings");
  });

  it("survives a reload (a new memory over the same storage) and sees another tab's change", () => {
    const storage = fakeStorage();
    createMemory(() => storage).bank(LISBON);
    const again = createMemory(() => storage);
    expect(again.banked()).toEqual([LISBON]);
    createMemory(() => storage).reject("AAA.a9");
    expect(again.rejected().has("AAA.a9")).toBe(true);
  });

  it("banking twice keeps one entry; a place is either banked or never-again, the latest word wins", () => {
    const storage = fakeStorage();
    const m = createMemory(() => storage);
    m.bank(LISBON);
    m.bank({ ...LISBON, at: 5 });
    expect(m.banked()).toEqual([{ ...LISBON, at: 5 }]);
    m.reject("AAA.a1");
    expect(m.banked()).toEqual([]);
    expect(m.rejected().has("AAA.a1")).toBe(true);
    m.bank(LISBON);
    expect(m.rejected().has("AAA.a1")).toBe(false);
    expect(m.banked().length).toBe(1);
    m.reject("AAA.a1");
    m.reject("AAA.a1");
    expect([...m.rejected()]).toEqual(["AAA.a1"]);
  });

  it("forget everything clears the bank and the never-again list but keeps the setting", () => {
    const storage = fakeStorage();
    const m = createMemory(() => storage);
    m.bank(LISBON);
    m.reject("AAA.a5");
    m.setIncludeAdvised(true);
    m.forgetEverything();
    expect(m.banked()).toEqual([]);
    expect(m.taken().size).toBe(0);
    expect(m.includeAdvised()).toBe(true);
    expect(JSON.parse(storage.getItem(BANKED_KEY) as string)).toEqual([]);
    expect(JSON.parse(storage.getItem(REJECTED_KEY) as string)).toEqual([]);
  });
});

describe("memory: corrupt storage", () => {
  it("treats unparseable or wrongly shaped values as empty, never throwing", () => {
    for (const bad of ["not json", "{}", "42", "null", '"text"', "[[[", ""]) {
      const storage = fakeStorage({ initial: { [BANKED_KEY]: bad, [REJECTED_KEY]: bad, [SETTINGS_KEY]: bad } });
      const m = createMemory(() => storage);
      expect(m.banked()).toEqual([]);
      expect(m.rejected().size).toBe(0);
      expect(m.includeAdvised()).toBe(false);
    }
  });

  it("drops entries of the wrong shape one by one and keeps the good ones", () => {
    const storage = fakeStorage({
      initial: {
        [BANKED_KEY]: JSON.stringify([LISBON, null, 7, { code: "x" }, { code: "", destinationId: "AAA.b", unitId: "AAA", at: 1 }, { ...PORTO, at: "later" }, LISBON]),
        [REJECTED_KEY]: JSON.stringify(["AAA.a5", 7, null, "", "AAA.a5", { a: 1 }]),
        [SETTINGS_KEY]: JSON.stringify({ includeAdvised: "yes" }),
      },
    });
    const m = createMemory(() => storage);
    expect(m.banked().map((e) => e.destinationId)).toEqual(["AAA.a3", "AAA.a1"]);
    expect(m.banked().find((e) => e.destinationId === "AAA.a3")?.at).toBe(0);
    expect([...m.rejected()]).toEqual(["AAA.a5"]);
    expect(m.includeAdvised()).toBe(false);
  });

  it("a corrupt value is overwritten by the next write", () => {
    const storage = fakeStorage({ initial: { [BANKED_KEY]: "garbage" } });
    const m = createMemory(() => storage);
    m.bank(LISBON);
    expect(JSON.parse(storage.getItem(BANKED_KEY) as string)).toEqual([LISBON]);
  });

  it("bounds a hostile value", () => {
    const many = Array.from({ length: 20_000 }, (_, i) => `AAA.x${i}`);
    const storage = fakeStorage({ initial: { [REJECTED_KEY]: JSON.stringify(many) } });
    expect(createMemory(() => storage).rejected().size).toBeLessThanOrEqual(5_000);
  });
});

describe("memory: blocked or full storage degrades to this visit", () => {
  it("no storage at all (null, or the lookup itself throws): works in memory and says it is not persistent", () => {
    for (const getStorage of [() => null, () => { throw new DOMException("denied", "SecurityError"); }]) {
      const m = createMemory(getStorage);
      m.bank(LISBON);
      m.reject("AAA.a5");
      m.setIncludeAdvised(true);
      expect(m.banked()).toEqual([LISBON]);
      expect(m.rejected().has("AAA.a5")).toBe(true);
      expect(m.includeAdvised()).toBe(true);
      expect(m.persistent).toBe(false);
      m.forgetEverything();
      expect(m.banked()).toEqual([]);
    }
  });

  it("reads that throw: this visit's own values are used", () => {
    const m = createMemory(() => fakeStorage({ throwOnGet: true }));
    m.bank(LISBON);
    m.reject("AAA.a5");
    expect(m.banked()).toEqual([LISBON]);
    expect(m.taken().size).toBe(2);
  });

  it("writes that throw (a full disk): the change lasts the visit", () => {
    const m = createMemory(() => fakeStorage({ throwOnSet: true }));
    m.bank(LISBON);
    m.setIncludeAdvised(true);
    expect(m.persistent).toBe(false);
    expect(() => m.reject("AAA.a5")).not.toThrow();
    // What the person did still holds for the visit, though nothing could be kept.
    expect(m.banked()).toEqual([LISBON]);
    expect(m.rejected().has("AAA.a5")).toBe(true);
    expect(m.includeAdvised()).toBe(true);
  });
});
