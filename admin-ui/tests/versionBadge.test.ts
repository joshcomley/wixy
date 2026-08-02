// Tests for the status-bar version badge (decisions/00109): pin-on-first-check,
// the green-glow update state, and the themed confirm/cancel dialog. The
// module under test uses the global `document` (jsdom provides it); `win` is a
// minimal fake so the confirmed reload is observable without jsdom navigation.

import { describe, expect, it, vi } from "vitest";
import { mountVersionBadge } from "../src/versionBadge";
import type { ServerVersion } from "../src/api";

function fakeWin(): { win: Window; reload: ReturnType<typeof vi.fn> } {
  const reload = vi.fn();
  return { win: { location: { reload } } as unknown as Window, reload };
}

/** The default notes feed for tests that don't exercise it (decisions/00112). */
const NO_NOTES = async (): Promise<string[] | null> => null;

async function flushMicro(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function openDialog(badge: ReturnType<typeof mountVersionBadge>): HTMLElement {
  badge.element.click();
  const backdrop = document.querySelector<HTMLElement>(".wx-version-backdrop");
  expect(backdrop).not.toBeNull();
  return backdrop!;
}

describe("versionBadge", () => {
  it("starts hidden and pins the loaded page's version on the first check", async () => {
    const { win } = fakeWin();
    const badge = mountVersionBadge({
      fetchVersion: async () => ({ shaFull: "a".repeat(40), count: 158 }),
      fetchNotes: NO_NOTES,
      win,
    });
    expect(badge.element.hidden).toBe(true);

    await badge.check();

    expect(badge.element.hidden).toBe(false);
    expect(badge.element.textContent).toBe("v158");
    expect(badge.element.classList.contains("wx-version-update-available")).toBe(false);
    badge.teardown();
  });

  it("stays hidden when the server has no count to show (gitless image)", async () => {
    const { win } = fakeWin();
    const badge = mountVersionBadge({
      fetchVersion: async () => ({ shaFull: "a".repeat(40), count: null }),
      fetchNotes: NO_NOTES,
      win,
    });
    await badge.check();
    expect(badge.element.hidden).toBe(true);
    badge.teardown();
  });

  it("glows `v old → v new` when a deploy lands past the loaded page", async () => {
    const { win } = fakeWin();
    let current: ServerVersion = { shaFull: "a".repeat(40), count: 158 };
    const badge = mountVersionBadge({ fetchVersion: async () => current, fetchNotes: NO_NOTES, win });
    await badge.check();

    current = { shaFull: "b".repeat(40), count: 159 };
    await badge.check();

    expect(badge.element.classList.contains("wx-version-update-available")).toBe(true);
    expect(badge.element.textContent).toBe("v158 → v159");
    badge.teardown();
  });

  it("goes quiet again when the server rolls back to the loaded sha", async () => {
    const { win } = fakeWin();
    const loaded: ServerVersion = { shaFull: "a".repeat(40), count: 158 };
    let current = loaded;
    const badge = mountVersionBadge({ fetchVersion: async () => current, fetchNotes: NO_NOTES, win });
    await badge.check();
    current = { shaFull: "b".repeat(40), count: 159 };
    await badge.check();
    expect(badge.element.classList.contains("wx-version-update-available")).toBe(true);

    current = loaded;
    await badge.check();
    expect(badge.element.classList.contains("wx-version-update-available")).toBe(false);
    expect(badge.element.textContent).toBe("v158");
    badge.teardown();
  });

  it("a failed or empty poll leaves the badge exactly as it was", async () => {
    const { win } = fakeWin();
    let behaviour: () => Promise<ServerVersion | null> = async () => ({
      shaFull: "a".repeat(40),
      count: 158,
    });
    const badge = mountVersionBadge({ fetchVersion: () => behaviour(), fetchNotes: NO_NOTES, win });
    await badge.check();
    expect(badge.element.textContent).toBe("v158");

    behaviour = async () => null;
    await badge.check();
    expect(badge.element.textContent).toBe("v158");

    behaviour = async () => {
      throw new Error("network down");
    };
    await badge.check();
    expect(badge.element.textContent).toBe("v158");
    badge.teardown();
  });

  it("tapping the quiet badge opens an up-to-date note, never a reload", async () => {
    const { win, reload } = fakeWin();
    const badge = mountVersionBadge({
      fetchVersion: async () => ({ shaFull: "a".repeat(40), count: 158 }),
      fetchNotes: NO_NOTES,
      win,
    });
    await badge.check();

    const backdrop = openDialog(badge);
    expect(backdrop.textContent).toContain("Wixy is up to date");
    expect(backdrop.textContent).toContain("latest version (v158)");
    expect(backdrop.querySelector(".wx-version-dialog-confirm")).toBeNull();

    backdrop.querySelector<HTMLButtonElement>(".wx-version-dialog-cancel")!.click();
    expect(document.querySelector(".wx-version-backdrop")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    badge.teardown();
  });

  it("the update dialog reloads ONLY after the explicit confirm — never on open, never on cancel", async () => {
    const { win, reload } = fakeWin();
    let current: ServerVersion = { shaFull: "a".repeat(40), count: 158 };
    const beforeReload = vi.fn();
    const badge = mountVersionBadge({ fetchVersion: async () => current, fetchNotes: NO_NOTES, win, beforeReload });
    await badge.check();
    current = { shaFull: "b".repeat(40), count: 159 };
    await badge.check();

    const backdrop = openDialog(badge);
    expect(backdrop.textContent).toContain("A new version of Wixy is ready");
    expect(backdrop.textContent).toContain("Would you like to load the latest version now?");
    expect(reload).not.toHaveBeenCalled();

    // Cancel first: closes, no reload, badge still glowing for later.
    backdrop.querySelector<HTMLButtonElement>(".wx-version-dialog-cancel")!.click();
    expect(document.querySelector(".wx-version-backdrop")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(badge.element.classList.contains("wx-version-update-available")).toBe(true);

    // Reopen and confirm: beforeReload (the OpQueue flush) runs, THEN reload.
    const backdrop2 = openDialog(badge);
    backdrop2.querySelector<HTMLButtonElement>(".wx-version-dialog-confirm")!.click();
    await flushMicro();
    expect(beforeReload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    badge.teardown();
  });

  it("a failed save BLOCKS the reload and says so — the queued edits are not silently lost", async () => {
    const { win, reload } = fakeWin();
    let current: ServerVersion = { shaFull: "a".repeat(40), count: 158 };
    let failFlush = true;
    const badge = mountVersionBadge({
      fetchVersion: async () => current,
      fetchNotes: NO_NOTES,
      win,
      beforeReload: () => {
        if (failFlush) throw new Error("patch never landed");
      },
    });
    await badge.check();
    current = { shaFull: "b".repeat(40), count: 159 };
    await badge.check();

    const backdrop = openDialog(badge);
    const confirm = backdrop.querySelector<HTMLButtonElement>(".wx-version-dialog-confirm")!;
    confirm.click();
    await flushMicro();

    expect(reload).not.toHaveBeenCalled();
    expect(backdrop.textContent).toContain("Couldn't save your latest change");
    expect(confirm.disabled).toBe(false); // re-enabled for the retry

    failFlush = false;
    confirm.click();
    await flushMicro();
    expect(reload).toHaveBeenCalledTimes(1);
    badge.teardown();
  });

  it("Escape and backdrop clicks close the dialog; teardown closes it too", async () => {
    const { win } = fakeWin();
    const badge = mountVersionBadge({
      fetchVersion: async () => ({ shaFull: "a".repeat(40), count: 158 }),
      fetchNotes: NO_NOTES,
      win,
    });
    await badge.check();

    openDialog(badge);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".wx-version-backdrop")).toBeNull();

    const backdrop = openDialog(badge);
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".wx-version-backdrop")).toBeNull();

    openDialog(badge);
    badge.teardown();
    expect(document.querySelector(".wx-version-backdrop")).toBeNull();
  });

  it("the update popup lists the What's-new lines — plain English, never a changelog (decisions/00112)", async () => {
    const { win } = fakeWin();
    let current: ServerVersion = { shaFull: "a".repeat(40), count: 158 };
    const seenSince: Array<string | null> = [];
    const badge = mountVersionBadge({
      fetchVersion: async () => current,
      fetchNotes: async (since) => {
        seenSince.push(since);
        return [
          "The update popup tells you what changed in plain English.",
          "General bug fixes and improvements.",
        ];
      },
      win,
    });
    await badge.check();
    current = { shaFull: "b".repeat(40), count: 159 };
    await badge.check();

    const backdrop = openDialog(badge);
    // The range is pinned to the LOADED page's sha — "what changed since the
    // version she's running", not since whenever.
    expect(seenSince).toEqual(["a".repeat(40)]);
    expect(backdrop.textContent).toContain("What's new in this version:");
    const items = backdrop.querySelectorAll(".wx-version-notes li");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe("The update popup tells you what changed in plain English.");
    expect(items[1]?.textContent).toBe("General bug fixes and improvements.");
    // No git detail anywhere — this surface is the site owner's.
    expect(backdrop.textContent).not.toMatch(/[0-9a-f]{40}/);
    badge.teardown();
  });

  it("a failed notes fetch still leaves a truthful popup (the generic line, not a blank)", async () => {
    const { win } = fakeWin();
    let current: ServerVersion = { shaFull: "a".repeat(40), count: 158 };
    const badge = mountVersionBadge({
      fetchVersion: async () => current,
      fetchNotes: async () => null,
      win,
    });
    await badge.check();
    current = { shaFull: "b".repeat(40), count: 159 };
    await badge.check();

    const backdrop = openDialog(badge);
    const items = backdrop.querySelectorAll(".wx-version-notes li");
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toBe("General bug fixes and improvements.");
    badge.teardown();
  });

  it("a dialog opened before the notes land shows a loading line, then fills in place", async () => {
    const { win } = fakeWin();
    let current: ServerVersion = { shaFull: "a".repeat(40), count: 158 };
    // Assigned synchronously by the promise executor the first time the badge
    // fetches notes (at the glow) — the no-op seed keeps TS's narrowing honest.
    let resolveNotes: (notes: string[]) => void = () => {};
    const badge = mountVersionBadge({
      fetchVersion: async () => current,
      fetchNotes: () =>
        new Promise<string[]>((resolve) => {
          resolveNotes = resolve;
        }),
      win,
    });
    await badge.check();
    current = { shaFull: "b".repeat(40), count: 159 };
    await badge.check();

    const backdrop = openDialog(badge);
    expect(backdrop.querySelector(".wx-version-notes-loading")?.textContent).toBe(
      "Loading what's new…",
    );

    resolveNotes(["The update popup tells you what changed in plain English."]);
    await flushMicro();
    expect(backdrop.querySelector(".wx-version-notes-loading")).toBeNull();
    expect(backdrop.querySelectorAll(".wx-version-notes li")).toHaveLength(1);
    badge.teardown();
  });
});
