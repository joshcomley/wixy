import { describe, expect, it, vi } from "vitest";
import type {
  AdminApi,
  PublishesEntry,
  RestoreOutcome,
  StateResponse,
  VersionDiff,
} from "../src/api";
import { mountHistoryPanel } from "../src/historyPanel";

function fakeState(overrides: { pages?: string[]; rev?: number } = {}): StateResponse {
  return {
    project: { slug: "test", name: "Test", domain: "test.example.invalid" },
    pages: (overrides.pages ?? ["index", "about"]).map((slug) => ({
      slug,
      meta: {},
      lastModified: null,
      editable: true,
      pendingDelete: false,
    })),
    draft: { rev: overrides.rev ?? 0, opCount: 0 },
    live: null,
    upstream: { aheadOfPublished: [], fetchedAt: null },
    publishJob: null,
    chats: [],
  };
}

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    getState: vi.fn(async (): Promise<StateResponse> => fakeState()),
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
    getVersionDiff: vi.fn(
      async (version: number): Promise<VersionDiff> => ({
        version,
        of: null,
        changes: {},
      }),
    ),
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

const TITLE_DIFF: VersionDiff = {
  version: 2,
  of: 1,
  changes: {
    index: [{ key: "hero.title", kind: "text", old: "V1 Title", new: "V2 Title" }],
  },
};

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("mountHistoryPanel", () => {
  it("shows 'Nothing published yet' when the ledger is empty", async () => {
    const panel = mountHistoryPanel({ api: fakeApi(), onDraftChanged: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.textContent).toContain("Nothing published yet.");
  });

  it("renders a publish entry's version/when/message/author/sha/changed", async () => {
    const api = fakeApi({ getPublishes: vi.fn(async () => [PUBLISH_ENTRY]) });
    const panel = mountHistoryPanel({ api, onDraftChanged: vi.fn() });
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
    const panel = mountHistoryPanel({ api, onDraftChanged: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    const row = panel.element.querySelector<HTMLTableRowElement>('tr[data-version="3"]');
    const cells = row?.querySelectorAll("td");
    expect(cells?.[2]?.textContent).toBe("Restore of version 1");
    expect(cells?.[3]?.textContent).toBe("restore");
  });

  it("the View link points at the archived version's index page", async () => {
    const api = fakeApi({ getPublishes: vi.fn(async () => [PUBLISH_ENTRY]) });
    const panel = mountHistoryPanel({ api, onDraftChanged: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    const link = panel.element.querySelector<HTMLAnchorElement>(".wx-history-view");
    expect(link?.getAttribute("href")).toBe("/admin/versions/2/index.html");
    expect(link?.target).toBe("_blank");
  });

  it("stamps the narrow-viewport restack hooks: per-cell classes + data-labels", async () => {
    const api = fakeApi({ getPublishes: vi.fn(async () => [PUBLISH_ENTRY]) });
    const panel = mountHistoryPanel({ api, onDraftChanged: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    const row = panel.element.querySelector<HTMLTableRowElement>('tr[data-version="2"]');
    expect(row).not.toBeNull();
    const cells = row?.querySelectorAll("td");
    // The ≤720px stylesheet hooks onto these classes/attributes to restack
    // each row as a compact list item (mirrors the pages table's hooks).
    expect(cells?.[0]?.className).toBe("wx-history-cell-version");
    expect(cells?.[1]?.className).toBe("wx-history-cell-when");
    expect(cells?.[2]?.className).toBe("wx-history-cell-message");
    expect(cells?.[3]?.className).toBe("wx-history-cell-meta");
    expect(cells?.[3]?.dataset["label"]).toBe("Author");
    expect(cells?.[4]?.className).toBe("wx-history-cell-meta");
    expect(cells?.[4]?.dataset["label"]).toBe("SHA");
    expect(cells?.[5]?.className).toBe("wx-history-cell-meta");
    expect(cells?.[5]?.dataset["label"]).toBe("Changed");
    expect(cells?.[6]?.className).toBe("wx-history-cell-actions");
  });

  it("formats the timestamp medium-date/short-time so it fits the narrow meta line", async () => {
    const api = fakeApi({ getPublishes: vi.fn(async () => [PUBLISH_ENTRY]) });
    const panel = mountHistoryPanel({ api, onDraftChanged: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    const row = panel.element.querySelector<HTMLTableRowElement>('tr[data-version="2"]');
    const whenCell = row?.querySelectorAll("td")?.[1];
    expect(whenCell?.textContent).toBe(
      new Date(PUBLISH_ENTRY.when).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    );
  });

  it("the confirm button stays disabled until the exact phrase is typed", async () => {
    const api = fakeApi({ getPublishes: vi.fn(async () => [PUBLISH_ENTRY]) });
    const panel = mountHistoryPanel({ api, onDraftChanged: vi.fn() });
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

  it("confirming calls api.restore and onDraftChanged, then removes the confirm row", async () => {
    const restore = vi.fn(async () => ({ kind: "ok" as const, version: 3, sha: "a".repeat(40), of: 2 }));
    const onDraftChanged = vi.fn();
    const api = fakeApi({ getPublishes: vi.fn(async () => [PUBLISH_ENTRY]), restore });
    const panel = mountHistoryPanel({ api, onDraftChanged });
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
    expect(onDraftChanged).toHaveBeenCalledOnce();
    expect(panel.element.querySelector(".wx-history-confirm")).toBeNull();
  });

  it("a failed restore keeps the confirm row open and shows the error", async () => {
    const restore = vi.fn(async () => ({ kind: "failed" as const, message: "no such version: 2" }));
    const api = fakeApi({ getPublishes: vi.fn(async () => [PUBLISH_ENTRY]), restore });
    const panel = mountHistoryPanel({ api, onDraftChanged: vi.fn() });
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
    const panel = mountHistoryPanel({ api, onDraftChanged: vi.fn() });
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
    const panel = mountHistoryPanel({ api: fakeApi(), onDraftChanged: vi.fn() });
    expect(() => panel.teardown()).not.toThrow();
  });
});

describe("mountHistoryPanel — per-version Changes view", () => {
  it("renders a Changes toggle per row, collapsed initially", async () => {
    const api = fakeApi({ getPublishes: vi.fn(async () => [PUBLISH_ENTRY]) });
    const panel = mountHistoryPanel({ api, onDraftChanged: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    const toggle = panel.element.querySelector<HTMLButtonElement>(".wx-history-changes");
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(panel.element.querySelector(".wx-history-diff")).toBeNull();
  });

  it("opening Changes loads the diff and renders old → new rows; toggling again closes it", async () => {
    const getVersionDiff = vi.fn(async () => TITLE_DIFF);
    const api = fakeApi({ getPublishes: vi.fn(async () => [PUBLISH_ENTRY]), getVersionDiff });
    const panel = mountHistoryPanel({ api, onDraftChanged: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    const toggle = panel.element.querySelector<HTMLButtonElement>(".wx-history-changes")!;
    toggle.click();
    await flush();

    expect(getVersionDiff).toHaveBeenCalledWith(2);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const diff = panel.element.querySelector(".wx-history-diff");
    expect(diff).not.toBeNull();
    const row = diff?.querySelector(".wx-diff-row");
    expect(row?.querySelector(".wx-diff-key")?.textContent).toBe("hero.title");
    const values = row?.querySelectorAll(".wx-diff-value");
    expect(values?.[0]?.textContent).toBe("V1 Title");
    expect(values?.[1]?.textContent).toBe("V2 Title");

    toggle.click();
    expect(panel.element.querySelector(".wx-history-diff")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the empty text when the version changed nothing", async () => {
    const getVersionDiff = vi.fn(
      async (version: number): Promise<VersionDiff> => ({ version, of: 1, changes: {} }),
    );
    const api = fakeApi({ getPublishes: vi.fn(async () => [PUBLISH_ENTRY]), getVersionDiff });
    const panel = mountHistoryPanel({ api, onDraftChanged: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    panel.element.querySelector<HTMLButtonElement>(".wx-history-changes")!.click();
    await flush();

    expect(panel.element.querySelector(".wx-diff-empty")?.textContent).toBe(
      "No content changes.",
    );
  });

  it("a failed diff load shows an error inside the detail row", async () => {
    const getVersionDiff = vi.fn(async (): Promise<VersionDiff> => {
      throw new Error("boom");
    });
    const api = fakeApi({ getPublishes: vi.fn(async () => [PUBLISH_ENTRY]), getVersionDiff });
    const panel = mountHistoryPanel({ api, onDraftChanged: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    panel.element.querySelector<HTMLButtonElement>(".wx-history-changes")!.click();
    await flush();

    expect(panel.element.querySelector(".wx-history-diff")?.textContent).toContain(
      "Couldn't load the changes.",
    );
  });
});

describe("mountHistoryPanel — Reinstate", () => {
  async function openDiff(
    api: AdminApi,
  ): Promise<ReturnType<typeof mountHistoryPanel>> {
    const panel = mountHistoryPanel({ api, onDraftChanged: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
    panel.element.querySelector<HTMLButtonElement>(".wx-history-changes")!.click();
    await flush();
    return panel;
  }

  it("patches the draft with the row's old value, then shows in-draft + fires onDraftChanged", async () => {
    const onDraftChanged = vi.fn();
    const getState = vi.fn(async (): Promise<StateResponse> => fakeState({ rev: 7 }));
    const patchDraft = vi.fn(async () => ({ kind: "ok" as const, rev: 8 }));
    const api = fakeApi({
      getPublishes: vi.fn(async () => [PUBLISH_ENTRY]),
      getVersionDiff: vi.fn(async () => TITLE_DIFF),
      getState,
      patchDraft,
    });
    const panel = mountHistoryPanel({ api, onDraftChanged });
    await Promise.resolve();
    await Promise.resolve();
    panel.element.querySelector<HTMLButtonElement>(".wx-history-changes")!.click();
    await flush();

    panel.element.querySelector<HTMLButtonElement>(".wx-diff-reinstate")!.click();
    await flush();

    expect(patchDraft).toHaveBeenCalledWith(7, [
      { file: "index", path: "hero.title", value: "V1 Title" },
    ]);
    expect(panel.element.querySelector(".wx-diff-reinstate")).toBeNull();
    expect(panel.element.querySelector(".wx-diff-reinstated")?.textContent).toContain(
      "In draft",
    );
    expect(onDraftChanged).toHaveBeenCalledOnce();
  });

  it("a rev conflict refetches state and retries once with the fresh rev", async () => {
    const getState = vi
      .fn()
      .mockImplementationOnce(async (): Promise<StateResponse> => fakeState({ rev: 7 }))
      .mockImplementationOnce(async (): Promise<StateResponse> => fakeState({ rev: 7 }))
      .mockImplementationOnce(async (): Promise<StateResponse> => fakeState({ rev: 9 }));
    const patchDraft = vi
      .fn()
      .mockImplementationOnce(async () => ({ kind: "conflict" as const }))
      .mockImplementationOnce(async () => ({ kind: "ok" as const, rev: 10 }));
    const api = fakeApi({
      getPublishes: vi.fn(async () => [PUBLISH_ENTRY]),
      getVersionDiff: vi.fn(async () => TITLE_DIFF),
      getState,
      patchDraft,
    });
    const panel = mountHistoryPanel({ api, onDraftChanged: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
    panel.element.querySelector<HTMLButtonElement>(".wx-history-changes")!.click();
    await flush();

    panel.element.querySelector<HTMLButtonElement>(".wx-diff-reinstate")!.click();
    await flush();

    expect(patchDraft).toHaveBeenCalledTimes(2);
    expect(patchDraft).toHaveBeenNthCalledWith(1, 7, [
      { file: "index", path: "hero.title", value: "V1 Title" },
    ]);
    expect(patchDraft).toHaveBeenNthCalledWith(2, 9, [
      { file: "index", path: "hero.title", value: "V1 Title" },
    ]);
    expect(panel.element.querySelector(".wx-diff-reinstated")).not.toBeNull();
  });

  it("offers no Reinstate for a key that version ADDED (there is no old value to reinstate)", async () => {
    const diff: VersionDiff = {
      version: 2,
      of: 1,
      changes: { index: [{ key: "hero.sub", kind: "text", old: null, new: "New" }] },
    };
    const api = fakeApi({
      getPublishes: vi.fn(async () => [PUBLISH_ENTRY]),
      getVersionDiff: vi.fn(async () => diff),
    });
    const panel = await openDiff(api);

    expect(panel.element.querySelector(".wx-diff-reinstate")).toBeNull();
  });

  it("offers no Reinstate when the changed page no longer exists in the draft", async () => {
    const getState = vi.fn(async (): Promise<StateResponse> => fakeState({ pages: ["about"] }));
    const api = fakeApi({
      getPublishes: vi.fn(async () => [PUBLISH_ENTRY]),
      getVersionDiff: vi.fn(async () => TITLE_DIFF),
      getState,
    });
    const panel = await openDiff(api);

    expect(panel.element.querySelector(".wx-diff-reinstate")).toBeNull();
  });

  it("theme and _global rows are always reinstatable (they can't be deleted)", async () => {
    const diff: VersionDiff = {
      version: 2,
      of: 1,
      changes: {
        theme: [{ key: "colors.cream", kind: "theme", old: "#F1E8D9", new: "#FFFFFF" }],
        _global: [{ key: "footer.line", kind: "text", old: "Old", new: "New" }],
      },
    };
    const getState = vi.fn(async (): Promise<StateResponse> => fakeState({ pages: [] }));
    const api = fakeApi({
      getPublishes: vi.fn(async () => [PUBLISH_ENTRY]),
      getVersionDiff: vi.fn(async () => diff),
      getState,
    });
    const panel = await openDiff(api);

    expect(panel.element.querySelectorAll(".wx-diff-reinstate")).toHaveLength(2);
  });
});
