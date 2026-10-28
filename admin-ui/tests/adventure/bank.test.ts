import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/server/api/messages";
import type { BankResult, BankTrip } from "../../src/server/adventure/api";
import { ServerLockedError } from "../../src/server/api/http";
import { createHolidayBank, type HolidayBank, type HolidayBankDeps } from "../../src/server/adventure/holidayBank";
import type { ServerSession } from "../../src/server/types";
import { DEST_A, DEST_B } from "./adventureFixtures";

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };

function trip(seq: number, name: string, over: Partial<BankTrip> = {}): BankTrip {
  return {
    seq,
    unitId: "AAA",
    unitName: "Aland",
    destination: { ...DEST_A, id: `AAA.${name.toLowerCase()}`, name },
    headline: `${name} is lovely`,
    pack: "ready",
    ...over,
  };
}

interface Rig {
  bank: HolidayBank;
  fetchBank: ReturnType<typeof vi.fn<(session: ServerSession) => Promise<BankResult>>>;
  openTrip: ReturnType<typeof vi.fn<(seq: number) => void>>;
  lockNow: ReturnType<typeof vi.fn>;
  timers: Array<{ fn: () => void; ms: number; id: number; live: boolean }>;
  session: { current: ServerSession | null };
}

function make(trips: readonly BankTrip[] = [trip(9, "Lisbon"), trip(4, "Porto")]): Rig {
  const fetchBank = vi.fn<(session: ServerSession) => Promise<BankResult>>(async () => ({ ok: true, trips }));
  const openTrip = vi.fn<(seq: number) => void>();
  const lockNow = vi.fn();
  const timers: Rig["timers"] = [];
  const session: Rig["session"] = { current: SESSION };
  const deps: HolidayBankDeps = {
    document,
    hooks: { lockNow },
    getSession: () => session.current,
    openTrip,
    fetchBank,
    setTimeout: (fn, ms) => {
      const t = { fn, ms, id: timers.length + 1, live: true };
      timers.push(t);
      return t.id;
    },
    clearTimeout: (id) => {
      const t = timers.find((x) => x.id === id);
      if (t !== undefined) t.live = false;
    },
  };
  const bank = createHolidayBank(deps);
  document.body.append(bank.element);
  return { bank, fetchBank, openTrip, lockNow, timers, session };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function trips(bank: HolidayBank): string[] {
  return [...bank.element.querySelectorAll(".wx-srv-bank-trip-name")].map((n) => n.textContent ?? "");
}

function adventureMessage(seq: number): Message {
  return { seq, clientId: "c", sender: "Ann", text: null, attachments: [], reactions: [], createdAt: 1, replyTo: null, adventure: { state: "banked", pack: "ready", rev: 3 } };
}

beforeEach(() => document.body.replaceChildren());
afterEach(() => document.body.replaceChildren());

describe("the Holiday bank screen", () => {
  it("opens below the chat header and lists the banked trips in the order the server gave (newest first)", async () => {
    const r = make();
    expect(r.bank.element.hidden).toBe(true);
    r.bank.open(52);
    expect(r.bank.element.hidden).toBe(false);
    expect(r.bank.element.style.top).toBe("52px");
    expect(r.bank.isOpen()).toBe(true);
    await flush();
    expect(r.fetchBank).toHaveBeenCalledWith(SESSION);
    expect(trips(r.bank)).toEqual(["Lisbon", "Porto"]);
    const first = r.bank.element.querySelector(".wx-srv-bank-trip");
    expect(first?.querySelector(".wx-srv-bank-trip-where")?.textContent).toBe("Alpha region, Aland");
    expect(first?.querySelector(".wx-srv-bank-trip-headline")?.textContent).toBe("Lisbon is lovely");
    expect(first?.hasAttribute("data-srv-gesture-boundary")).toBe(true);
  });

  it("shows the place's own blurb when the research has no headline yet", async () => {
    const r = make([trip(9, "Lisbon", { headline: null, pack: "pending" })]);
    r.bank.open(0);
    await flush();
    expect(r.bank.element.querySelector(".wx-srv-bank-trip-headline")?.textContent).toBe(DEST_A.blurb);
  });

  it("says so when nothing is saved yet", async () => {
    const r = make([]);
    r.bank.open(0);
    expect(r.bank.element.querySelector<HTMLElement>(".wx-srv-bank-loading")?.hidden).toBe(false);
    await flush();
    expect(r.bank.element.querySelector<HTMLElement>(".wx-srv-bank-empty")?.hidden).toBe(false);
    expect(r.bank.element.querySelector<HTMLElement>(".wx-srv-bank-loading")?.hidden).toBe(true);
    expect(r.bank.element.querySelectorAll(".wx-srv-bank-trip")).toHaveLength(0);
  });

  it("a tap on a trip closes the screen and opens that trip in the game tab", async () => {
    const r = make();
    r.bank.open(0);
    await flush();
    r.bank.element.querySelectorAll<HTMLButtonElement>(".wx-srv-bank-trip")[1]?.click();
    expect(r.bank.isOpen()).toBe(false);
    expect(r.bank.element.hidden).toBe(true);
    expect(r.openTrip).toHaveBeenCalledWith(4);
  });

  it("Back to chat closes it and forgets the list", async () => {
    const r = make();
    r.bank.open(0);
    await flush();
    r.bank.element.querySelector<HTMLButtonElement>(".wx-srv-bank-close")?.click();
    expect(r.bank.isOpen()).toBe(false);
    expect(r.bank.element.querySelectorAll(".wx-srv-bank-trip")).toHaveLength(0);
  });

  it("a failed load says so and offers Try again; a lock (401) locks the chat", async () => {
    const r = make();
    r.fetchBank.mockResolvedValueOnce({ ok: false, kind: "unavailable" });
    r.bank.open(0);
    await flush();
    expect(r.bank.element.querySelector(".wx-srv-bank-error")?.textContent).toBe("Couldn't load the Holiday bank.");
    const retry = r.bank.element.querySelector<HTMLButtonElement>(".wx-srv-bank-retry")!;
    expect(retry.hidden).toBe(false);
    retry.click();
    await flush();
    expect(trips(r.bank)).toEqual(["Lisbon", "Porto"]);
    expect(r.bank.element.querySelector<HTMLElement>(".wx-srv-bank-error")?.hidden).toBe(true);

    const locked = make();
    locked.fetchBank.mockImplementationOnce(() => {
      const rejected = Promise.reject(new ServerLockedError());
      rejected.catch(() => {});
      return rejected;
    });
    locked.bank.open(0);
    await flush();
    expect(locked.lockNow).toHaveBeenCalledWith("unauthorized");
  });

  it("asks nothing while there is no session", async () => {
    const r = make();
    r.session.current = null;
    r.bank.open(0);
    await flush();
    expect(r.fetchBank).not.toHaveBeenCalled();
  });

  it("closing while a request is out drops its answer (a lock must leave nothing on screen)", async () => {
    let release!: (result: BankResult) => void;
    const r = make();
    r.fetchBank.mockImplementationOnce(() => new Promise<BankResult>((resolve) => (release = resolve)));
    r.bank.open(0);
    r.bank.close();
    release({ ok: true, trips: [trip(9, "Lisbon")] });
    await flush();
    expect(trips(r.bank)).toEqual([]);
    // ...and reopening starts clean.
    r.bank.open(0);
    await flush();
    expect(trips(r.bank)).toEqual(["Lisbon", "Porto"]);
  });
});

describe("the Holiday bank while it is open", () => {
  it("re-reads once, after a short pause, when an adventure message changes; ignores other messages and a closed screen", async () => {
    const r = make();
    r.bank.messageChanged(adventureMessage(9));
    expect(r.timers).toHaveLength(0); // closed
    r.bank.open(0);
    await flush();
    r.bank.messageChanged({ ...adventureMessage(9), adventure: null });
    expect(r.timers).toHaveLength(0);
    r.bank.messageChanged(adventureMessage(9));
    r.bank.messageChanged(adventureMessage(10)); // a burst becomes one request
    expect(r.timers.filter((t) => t.live)).toHaveLength(1);
    r.fetchBank.mockResolvedValueOnce({ ok: true, trips: [trip(10, "Faro"), trip(9, "Lisbon")] });
    r.timers[0]?.fn();
    await flush();
    expect(trips(r.bank)).toEqual(["Faro", "Lisbon"]);
  });

  it("drops a deleted trip at once, without a request", async () => {
    const r = make();
    r.bank.open(0);
    await flush();
    r.fetchBank.mockClear();
    r.bank.messageDeleted(9);
    expect(trips(r.bank)).toEqual(["Porto"]);
    r.bank.messageDeleted(123);
    expect(trips(r.bank)).toEqual(["Porto"]);
    expect(r.fetchBank).not.toHaveBeenCalled();
  });

  it("closing cancels a pending re-read", async () => {
    const r = make();
    r.bank.open(0);
    await flush();
    r.bank.messageChanged(adventureMessage(9));
    r.bank.close();
    expect(r.timers.filter((t) => t.live)).toHaveLength(0);
  });
});

void DEST_B;
