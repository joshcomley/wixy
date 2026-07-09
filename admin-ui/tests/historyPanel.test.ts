import { describe, expect, it, vi } from "vitest";
import type { AdminApi, PublishesEntry, RestoreOutcome } from "../src/api";
import { mountHistoryPanel } from "../src/historyPanel";

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    getState: vi.fn(),
    getContent: vi.fn(),
    patchDraft: vi.fn(),
    discardDraft: vi.fn(),
    getMedia: vi.fn(),
    uploadMedia: vi.fn(),
    deleteMedia: vi.fn(),
    getTheme: vi.fn(),
    getPublishPreview: vi.fn(),
    publish: vi.fn(),
    getPublishes: vi.fn(async (): Promise<PublishesEntry[]> => []),
    restore: vi.fn(async (): Promise<RestoreOutcome> => ({ kind: "ok", version: 3, sha: "a".repeat(40), of: 1 })),
    ...overrides,
  } as AdminApi;
}

const PUBLISH_ENTRY: PublishesEntry = {
  version: 2,
  sha: "abcdef1234567890",
  when: "2026-01-05T10:00:00+00:00",
  live: true,
  message: "second publish",
  source: "editor",
  changed: { index: ["hero.title"] },
};

const RESTORE_ENTRY: PublishesEntry = {
  version: 3,
  sha: "abcdef1234567890",
  when: "2026-01-06T10:00:00+00:00",
  live: false,
  action: "restore",
  of: 1,
};

describe("mountHistoryPanel", () => {
  it("shows 'Nothing published yet' when the ledger is empty", async () => {
    const panel = mountHistoryPanel({ api: fakeApi(), onRestored: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.textContent).toContain("Nothing published yet.");
  });

  it("renders a publish entry's version/when/message/author/sha/changed", async () => {
    const api = fakeApi({ getPublishes: vi.fn(async () => [PUBLISH_ENTRY]) });
    const panel = mountHistoryPanel({ api, onRestored: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    const row = panel.element.querySelector<HTMLTableRowElement>('tr[data-version="2"]');
    expect(row).not.toBeNull();
    const cells = row?.querySelectorAll("td");
    expect(cells?.[0]?.textContent).toBe("2 (live)");
    expect(cells?.[2]?.textContent).toBe("second publish");
    expect(cells?.[3]?.textContent).toBe("editor");
    expect(cells?.[4]?.textContent).toBe("abcdef12");
    expect(cells?.[5]?.textContent).toBe("index (1)");
    expect(row?.classList.contains("wx-history-live")).toBe(true);
  });

  it("renders a restore entry as 'Restore of version N' with author 'restore'", async () => {
    const api = fakeApi({ getPublishes: vi.fn(async () => [RESTORE_ENTRY]) });
    const panel = mountHistoryPanel({ api, onRestored: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    const row = panel.element.querySelector<HTMLTableRowElement>('tr[data-version="3"]');
    const cells = row?.querySelectorAll("td");
    expect(cells?.[2]?.textContent).toBe("Restore of version 1");
    expect(cells?.[3]?.textContent).toBe("restore");
  });

  it("the View link points at the archived version's index page", async () => {
    const api = fakeApi({ getPublishes: vi.fn(async () => [PUBLISH_ENTRY]) });
    const panel = mountHistoryPanel({ api, onRestored: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    const link = panel.element.querySelector<HTMLAnchorElement>(".wx-history-view");
    expect(link?.getAttribute("href")).toBe("/admin/versions/2/index.html");
    expect(link?.target).toBe("_blank");
  });

  it("the confirm button stays disabled until the exact phrase is typed", async () => {
    const api = fakeApi({ getPublishes: vi.fn(async () => [PUBLISH_ENTRY]) });
    const panel = mountHistoryPanel({ api, onRestored: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    panel.element.querySelector<HTMLButtonElement>(".wx-history-restore")?.click();
    const confirmButton = Array.from(panel.element.querySelectorAll("button")).find(
      (b) => b.textContent === "Confirm restore",
    );
    const input = panel.element.querySelector<HTMLInputElement>(".wx-history-confirm input");
    expect(confirmButton?.disabled).toBe(true);

    input!.value = "resto";
    input!.dispatchEvent(new Event("input"));
    expect(confirmButton?.disabled).toBe(true);

    input!.value = "RESTORE";
    input!.dispatchEvent(new Event("input"));
    expect(confirmButton?.disabled).toBe(false);
  });

  it("confirming calls api.restore and onRestored, then removes the confirm row", async () => {
    const restore = vi.fn(async () => ({ kind: "ok" as const, version: 3, sha: "a".repeat(40), of: 2 }));
    const onRestored = vi.fn();
    const api = fakeApi({ getPublishes: vi.fn(async () => [PUBLISH_ENTRY]), restore });
    const panel = mountHistoryPanel({ api, onRestored });
    await Promise.resolve();
    await Promise.resolve();

    panel.element.querySelector<HTMLButtonElement>(".wx-history-restore")?.click();
    const input = panel.element.querySelector<HTMLInputElement>(".wx-history-confirm input")!;
    input.value = "RESTORE";
    input.dispatchEvent(new Event("input"));
    const confirmButton = Array.from(panel.element.querySelectorAll("button")).find(
      (b) => b.textContent === "Confirm restore",
    );
    confirmButton?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(restore).toHaveBeenCalledWith(2);
    expect(onRestored).toHaveBeenCalledOnce();
    expect(panel.element.querySelector(".wx-history-confirm")).toBeNull();
  });

  it("a failed restore keeps the confirm row open and shows the error", async () => {
    const restore = vi.fn(async () => ({ kind: "failed" as const, message: "no such version: 2" }));
    const api = fakeApi({ getPublishes: vi.fn(async () => [PUBLISH_ENTRY]), restore });
    const panel = mountHistoryPanel({ api, onRestored: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    panel.element.querySelector<HTMLButtonElement>(".wx-history-restore")?.click();
    const input = panel.element.querySelector<HTMLInputElement>(".wx-history-confirm input")!;
    input.value = "RESTORE";
    input.dispatchEvent(new Event("input"));
    const confirmButton = Array.from(panel.element.querySelectorAll("button")).find(
      (b) => b.textContent === "Confirm restore",
    );
    confirmButton?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.querySelector(".wx-history-error")?.textContent).toBe("no such version: 2");
    expect(confirmButton?.disabled).toBe(false);
  });

  it("cancel removes the confirm row without calling restore", async () => {
    const restore = vi.fn();
    const api = fakeApi({ getPublishes: vi.fn(async () => [PUBLISH_ENTRY]), restore });
    const panel = mountHistoryPanel({ api, onRestored: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    panel.element.querySelector<HTMLButtonElement>(".wx-history-restore")?.click();
    const cancelButton = Array.from(panel.element.querySelectorAll("button")).find(
      (b) => b.textContent === "Cancel",
    );
    cancelButton?.click();

    expect(panel.element.querySelector(".wx-history-confirm")).toBeNull();
    expect(restore).not.toHaveBeenCalled();
  });

  it("teardown does not throw", () => {
    const panel = mountHistoryPanel({ api: fakeApi(), onRestored: vi.fn() });
    expect(() => panel.teardown()).not.toThrow();
  });
});
