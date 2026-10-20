import { afterEach, describe, expect, it, vi } from "vitest";
import type { WyrTopic, WyrTopicsResult } from "../src/server/api/wyr";
import type { ServerSession } from "../src/server/types";
import { createWyrTopics } from "../src/server/wyrTopics";

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };

const TOPICS: WyrTopic[] = [
  { id: "food-meals", label: "Food: meals", count: 237, selected: true },
  { id: "food-sweet", label: "Food: sweet treats", count: 240, selected: true },
  { id: "technology", label: "Technology", count: 8, selected: true },
];

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function setup(initial: readonly WyrTopic[] = TOPICS) {
  const load = vi.fn(async (): Promise<WyrTopicsResult> => ({ ok: true, topics: initial }));
  const save = vi.fn(
    async (_s: ServerSession, chosen: readonly string[]): Promise<WyrTopicsResult> => ({
      ok: true,
      topics: TOPICS.map((t) => ({ ...t, selected: chosen.includes(t.id) })),
    }),
  );
  const lockNow = vi.fn();
  const view = createWyrTopics({ document, hooks: { lockNow }, getSession: () => SESSION, load, save });
  document.body.appendChild(view.element);
  const q = <T extends HTMLElement>(sel: string) => view.element.querySelector<T>(sel)!;
  const boxes = () => Array.from(view.element.querySelectorAll<HTMLInputElement>(".wx-srv-topics-box"));
  return { view, load, save, lockNow, q, boxes };
}

afterEach(() => document.body.replaceChildren());

describe("game topics screen", () => {
  it("lists every topic with its count and the current choice", async () => {
    const { view, boxes, q } = setup([{ ...TOPICS[0]!, selected: true }, { ...TOPICS[1]!, selected: false }, TOPICS[2]!]);
    view.open(48);
    await flush();
    expect(view.element.hidden).toBe(false);
    expect(view.element.style.top).toBe("48px");
    expect(boxes().map((b) => b.checked)).toEqual([true, false, true]);
    expect(view.element.querySelectorAll(".wx-srv-topics-count")[0]!.textContent).toBe("237");
    expect(q(".wx-srv-topics-summary").textContent).toBe("2 of 3 topics · 245 questions");
  });

  it("selects all, unselects all (and then cannot save), and ticks any mix", async () => {
    const { view, boxes, q, save } = setup();
    view.open(0);
    await flush();
    q<HTMLButtonElement>(".wx-srv-topics-none").click();
    expect(boxes().every((b) => !b.checked)).toBe(true);
    expect(q(".wx-srv-topics-summary").textContent).toBe("Pick at least one topic");
    expect(q<HTMLButtonElement>(".wx-srv-topics-save").disabled).toBe(true);
    q<HTMLButtonElement>(".wx-srv-topics-save").click();
    expect(save).not.toHaveBeenCalled();

    boxes()[0]!.checked = true;
    boxes()[0]!.dispatchEvent(new Event("change"));
    boxes()[1]!.checked = true;
    boxes()[1]!.dispatchEvent(new Event("change"));
    expect(q<HTMLButtonElement>(".wx-srv-topics-save").disabled).toBe(false);
    q<HTMLButtonElement>(".wx-srv-topics-all").click();
    expect(boxes().every((b) => b.checked)).toBe(true);
  });

  it("saves exactly the ticked topics and confirms", async () => {
    const { view, boxes, q, save } = setup();
    view.open(0);
    await flush();
    q<HTMLButtonElement>(".wx-srv-topics-none").click();
    for (const index of [0, 1]) {
      boxes()[index]!.checked = true;
      boxes()[index]!.dispatchEvent(new Event("change"));
    }
    q<HTMLButtonElement>(".wx-srv-topics-save").click();
    await flush();
    expect(save).toHaveBeenCalledWith(SESSION, ["food-meals", "food-sweet"]);
    expect(q(".wx-srv-topics-status").textContent).toContain("Saved");
    expect(boxes().map((b) => b.checked)).toEqual([true, true, false]);
  });

  it("says so when the game cannot be reached, and ignores a response after close", async () => {
    const { view, load, q } = setup();
    load.mockResolvedValueOnce({ ok: false, kind: "unavailable" });
    view.open(0);
    await flush();
    expect(q(".wx-srv-topics-status").textContent).toContain("try again");

    view.close();
    let release: (r: WyrTopicsResult) => void = () => {};
    load.mockImplementationOnce(() => new Promise<WyrTopicsResult>((resolve) => (release = resolve)));
    view.open(0);
    view.close();
    release({ ok: true, topics: TOPICS });
    await flush();
    expect(view.element.querySelectorAll(".wx-srv-topics-box")).toHaveLength(0);
    expect(view.isOpen()).toBe(false);
  });
});
