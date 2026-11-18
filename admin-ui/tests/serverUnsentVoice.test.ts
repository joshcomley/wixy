import { describe, expect, it, vi } from "vitest";
import { createUnsentVoiceCards } from "../src/server/unsentVoice";
import { formatVoiceTime } from "../src/server/voiceTime";
import type { UnsentUpload } from "../src/server/api/uploads";

function entry(id: string, durationMs: number): UnsentUpload {
  return { uploadId: id, durationMs, sizeBytes: 1000, startedAt: 1, lastChunkAt: 2 };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function mount(overrides: { send?: (e: UnsentUpload) => Promise<void>; discard?: (e: UnsentUpload) => Promise<void> } = {}) {
  const send = vi.fn(overrides.send ?? (async () => undefined));
  const discard = vi.fn(overrides.discard ?? (async () => undefined));
  const cards = createUnsentVoiceCards({ document, send, discard });
  document.body.appendChild(cards.element);
  const card = (id: string) => cards.element.querySelector<HTMLElement>(`[data-upload-id="${id}"]`);
  const button = (id: string, kind: "send" | "discard") =>
    card(id)?.querySelector<HTMLButtonElement>(`.wx-srv-unsent-${kind}`) ?? null;
  const error = (id: string) => card(id)?.querySelector<HTMLElement>(".wx-srv-unsent-error") ?? null;
  return { cards, send, discard, card, button, error };
}

describe("formatVoiceTime", () => {
  it.each([
    [0, "0:00"],
    [999, "0:00"],
    [5_000, "0:05"],
    [751_000, "12:31"],
    [3_599_999, "59:59"],
    [3_600_000, "1:00:00"],
    [3_723_000, "1:02:03"],
    [14_400_000, "4:00:00"],
    [-5, "0:00"],
    [Number.NaN, "0:00"],
  ])("formats %s ms as %s", (ms, text) => {
    expect(formatVoiceTime(ms)).toBe(text);
  });
});

describe("unsent voice note cards", () => {
  it("shows nothing while there is nothing unsent", () => {
    const { cards } = mount();
    expect(cards.element.hidden).toBe(true);
    cards.setEntries([]);
    expect(cards.element.hidden).toBe(true);
    expect(cards.element.children).toHaveLength(0);
  });

  it("renders one card per entry, newest first, with the label, Send and Discard", () => {
    const { cards, card } = mount();
    cards.setEntries([entry("b", 751_000), entry("a", 3_723_000)]);
    expect(cards.element.hidden).toBe(false);
    expect([...cards.element.children].map((c) => (c as HTMLElement).dataset.uploadId)).toEqual(["b", "a"]);
    expect(card("b")?.querySelector(".wx-srv-unsent-label")?.textContent).toBe("Unsent voice note · 12:31");
    expect(card("a")?.querySelector(".wx-srv-unsent-label")?.textContent).toBe("Unsent voice note · 1:02:03");
    expect(card("b")?.querySelector(".wx-srv-unsent-send")?.textContent).toBe("Send");
    expect(card("b")?.querySelector(".wx-srv-unsent-discard")?.textContent).toBe("Discard");
  });

  it("never sends anything by itself", () => {
    const { cards, send, discard } = mount();
    cards.setEntries([entry("a", 60_000)]);
    expect(send).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it("Send answers at once (both buttons disabled, 'Sending…'), then removes the card on success", async () => {
    const gate = deferred();
    const { cards, send, button, card } = mount({ send: () => gate.promise });
    cards.setEntries([entry("a", 60_000), entry("b", 90_000)]);

    button("a", "send")?.click();

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ uploadId: "a" }));
    expect(button("a", "send")?.disabled).toBe(true);
    expect(button("a", "discard")?.disabled).toBe(true);
    expect(button("a", "send")?.textContent).toBe("Sending…");
    expect(button("b", "send")?.disabled).toBe(false);

    gate.resolve();
    await flush();
    expect(card("a")).toBeNull();
    expect(card("b")).not.toBeNull();
    expect(cards.element.hidden).toBe(false);
  });

  it("Discard answers at once ('Discarding…'), then removes the card and hides the list when it was the last", async () => {
    const gate = deferred();
    const { cards, discard, button, card } = mount({ discard: () => gate.promise });
    cards.setEntries([entry("a", 60_000)]);

    button("a", "discard")?.click();
    expect(discard).toHaveBeenCalledOnce();
    expect(button("a", "discard")?.textContent).toBe("Discarding…");
    expect(button("a", "send")?.disabled).toBe(true);

    gate.resolve();
    await flush();
    expect(card("a")).toBeNull();
    expect(cards.element.hidden).toBe(true);
  });

  it("a failed Send re-enables both buttons and shows a short error line, then can be tried again", async () => {
    let attempt = 0;
    const { cards, send, button, error, card } = mount({
      send: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("Couldn't send. Try again.");
      },
    });
    cards.setEntries([entry("a", 60_000)]);

    button("a", "send")?.click();
    await flush();

    expect(card("a")).not.toBeNull();
    expect(button("a", "send")?.disabled).toBe(false);
    expect(button("a", "discard")?.disabled).toBe(false);
    expect(button("a", "send")?.textContent).toBe("Send");
    expect(error("a")?.hidden).toBe(false);
    expect(error("a")?.textContent).toBe("Couldn't send. Try again.");

    button("a", "send")?.click();
    expect(error("a")?.hidden).toBe(true);
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(card("a")).toBeNull();
  });

  it("a failed Discard re-enables the buttons with an error line; a non-Error failure gets a default one", async () => {
    const { cards, button, error } = mount({ discard: () => Promise.reject("boom") });
    cards.setEntries([entry("a", 60_000)]);
    button("a", "discard")?.click();
    await flush();
    expect(button("a", "discard")?.disabled).toBe(false);
    expect(button("a", "discard")?.textContent).toBe("Discard");
    expect(error("a")?.textContent).toBe("Couldn't discard. Try again.");
  });

  it("a refresh keeps a card that is mid-send, keeps shown cards' state, and drops the ones the server no longer lists", async () => {
    const gate = deferred();
    const { cards, button, card } = mount({ send: () => gate.promise });
    cards.setEntries([entry("a", 60_000), entry("b", 90_000)]);
    button("a", "send")?.click();

    cards.setEntries([entry("c", 30_000)]);

    expect(card("a")).not.toBeNull(); // busy: kept
    expect(button("a", "send")?.textContent).toBe("Sending…");
    expect(card("b")).toBeNull();
    expect(card("c")).not.toBeNull();
    gate.resolve();
    await flush();
    expect(card("a")).toBeNull();
  });

  it("clear() (a lock) removes every card", () => {
    const { cards } = mount();
    cards.setEntries([entry("a", 60_000)]);
    cards.clear();
    expect(cards.element.hidden).toBe(true);
    expect(cards.element.children).toHaveLength(0);
  });

  it("gives each button a name that starts with its visible text (label in name)", () => {
    const { cards, button } = mount();
    cards.setEntries([entry("a", 751_000)]);
    expect(button("a", "send")?.getAttribute("aria-label")).toBe("Send unsent voice note, 12:31");
    expect(button("a", "discard")?.getAttribute("aria-label")).toBe("Discard unsent voice note, 12:31");
  });
});
