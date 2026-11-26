import { afterEach, describe, expect, it, vi } from "vitest";
import type { BankResult, BankTrip } from "../../src/server/adventure/api";
import { createHolidayBank, type HolidayBank, type HolidayBankDeps, type HolidayBankSource } from "../../src/server/adventure/holidayBank";
import type { ShareTarget } from "../../src/server/adventure/shareLink";
import { DEST_A } from "../adventure/adventureFixtures";

// The Holiday bank's data-source seam (spec/adventure-public section 2.4): the private chat reads
// `GET /adventure/bank` (tests/adventure/bank.test.ts, untouched); the public page reads this browser's memory.

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(window.navigator, "clipboard");
});

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function trip(seq: number, name: string, over: Partial<BankTrip> = {}): BankTrip {
  return { seq, unitId: "AAA", unitName: "Aland", destination: { ...DEST_A, id: `AAA.${name.toLowerCase()}`, name }, headline: null, pack: "none", code: `code${seq}x`, at: 1_700_000_000, ...over };
}

function make(trips: readonly BankTrip[], over: Partial<HolidayBankDeps> = {}, withOpenPlace = true) {
  const load = vi.fn<HolidayBankSource["load"]>(() => ({ ok: true, trips }) as BankResult);
  const openTrip = vi.fn<(seq: number) => void>();
  const openPlace = vi.fn<(trip: BankTrip) => void>();
  const bank: HolidayBank = createHolidayBank({
    document,
    source: { load },
    openTrip,
    ...(withOpenPlace ? { openPlace } : {}),
    shareLink: (t) => (t.code === undefined ? null : ({ url: `https://adventure.cinnamons.uk/d/${t.code}`, title: t.destination.name, text: t.destination.name } satisfies ShareTarget)),
    closeLabel: "Back to the globe",
    emptyText: "Nothing banked yet.",
    ...over,
  });
  document.body.append(bank.element);
  return { bank, load, openTrip, openPlace };
}

describe("holiday bank: a data source other than the chat's server", () => {
  it("reads its rows from the source (no session, no hooks needed)", async () => {
    const r = make([trip(1, "Lisbon"), trip(2, "Porto")]);
    r.bank.open(0);
    await flush();
    expect(r.load).toHaveBeenCalledTimes(1);
    expect([...document.querySelectorAll(".wx-srv-bank-trip-name")].map((n) => n.textContent)).toEqual(["Lisbon", "Porto"]);
    expect(document.querySelector(".wx-srv-bank-close")?.textContent).toBe("Back to the globe");
  });

  it("an empty source shows the given empty text", async () => {
    const r = make([]);
    r.bank.open(0);
    await flush();
    expect(document.querySelector<HTMLElement>(".wx-srv-bank-empty")?.hidden).toBe(false);
    expect(document.querySelector(".wx-srv-bank-empty")?.textContent).toBe("Nothing banked yet.");
  });

  it("a failing source shows the error and Try again reads it again", async () => {
    const load = vi.fn<HolidayBankSource["load"]>().mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ ok: true, trips: [trip(1, "Lisbon")] });
    const r = make([], { source: { load } });
    r.bank.open(0);
    await flush();
    expect(document.querySelector<HTMLElement>(".wx-srv-bank-error")?.hidden).toBe(false);
    document.querySelector<HTMLElement>(".wx-srv-bank-retry")?.click();
    await flush();
    expect(document.querySelectorAll(".wx-srv-bank-trip")).toHaveLength(1);
    expect(r.load).not.toHaveBeenCalled();
  });

  it("a tap calls openPlace with the trip (and not openTrip), after closing itself", async () => {
    const r = make([trip(1, "Lisbon"), trip(2, "Porto")]);
    r.bank.open(0);
    await flush();
    document.querySelectorAll<HTMLElement>(".wx-srv-bank-trip")[1]?.click();
    expect(r.openPlace).toHaveBeenCalledTimes(1);
    expect(r.openPlace.mock.calls[0]?.[0].destination.name).toBe("Porto");
    expect(r.openTrip).not.toHaveBeenCalled();
    expect(r.bank.isOpen()).toBe(false);
  });

  it("without openPlace a tap falls back to openTrip(seq), as in the chat", async () => {
    const r = make([trip(9, "Lisbon")], {}, false);
    r.bank.open(0);
    await flush();
    document.querySelector<HTMLElement>(".wx-srv-bank-trip")?.click();
    expect(r.openTrip).toHaveBeenCalledWith(9);
  });

  it("a row has a Copy link beside it when the trip has a link; the button copies it and says so", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const timers: Array<() => void> = [];
    const { code: _unused, ...noCode } = trip(2, "Porto");
    const r = make([trip(1, "Lisbon"), noCode], { setTimeout: (fn) => timers.push(fn) });
    r.bank.open(0);
    await flush();
    const rows = document.querySelectorAll(".wx-srv-bank-trips > *");
    expect(rows[0]?.className).toBe("wx-srv-bank-trip-row");
    expect(rows[1]?.className).toBe("wx-srv-bank-trip"); // no link: a bare row, as in the chat
    const copy = document.querySelector<HTMLButtonElement>(".wx-srv-bank-trip-copy");
    expect(copy?.getAttribute("aria-label")).toBe("Copy the link to Lisbon");
    copy?.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith("https://adventure.cinnamons.uk/d/code1x");
    expect(copy?.textContent).toBe("Link copied");
    timers[0]?.();
    expect(copy?.textContent).toBe("Copy link");
    // The Copy link is its own control: it does not open the place.
    expect(r.openPlace).not.toHaveBeenCalled();
  });

  it("a gone place is greyed, says so, and cannot be opened; the date banked is shown", async () => {
    const r = make([trip(1, "Lisbon", { gone: true })]);
    r.bank.open(0);
    await flush();
    const row = document.querySelector<HTMLButtonElement>(".wx-srv-bank-trip");
    expect(row?.disabled).toBe(true);
    expect(row?.classList.contains("wx-srv-bank-trip-gone")).toBe(true);
    expect(row?.textContent).toContain("No longer on the map");
    expect(row?.textContent).toContain("Banked");
    row?.click();
    expect(r.openPlace).not.toHaveBeenCalled();
  });

  it("the chat's own rows are unchanged: no date, no copy button, bare buttons", async () => {
    const fetchBank = vi.fn(async (): Promise<BankResult> => ({ ok: true, trips: [{ seq: 4, unitId: "AAA", unitName: "Aland", destination: DEST_A, headline: "Sun", pack: "ready" }] }));
    const bank = createHolidayBank({ document, hooks: { lockNow: vi.fn() }, getSession: () => ({ token: "t", expiresAt: 1 }), openTrip: vi.fn(), fetchBank });
    document.body.append(bank.element);
    bank.open(10);
    await flush();
    expect(document.querySelector(".wx-srv-bank-trips")?.children[0]?.className).toBe("wx-srv-bank-trip");
    expect(document.querySelector(".wx-srv-bank-trip-date")).toBeNull();
    expect(document.querySelector(".wx-srv-bank-trip-copy")).toBeNull();
    expect(document.querySelector(".wx-srv-bank-close")?.textContent).toBe("Back to chat");
  });
});
