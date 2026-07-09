import { describe, expect, it, vi } from "vitest";
import { mountShell } from "../src/shell";
import type { AdminApi, StateResponse } from "../src/api";
import type { EditView, MountEditViewDeps } from "../src/editView";
import type { DraftOp } from "../src/protocol";

function fakeWindow(): Window {
  const listeners = new Map<string, Set<() => void>>();
  let hash = "";
  const win = {
    location: {
      get hash() {
        return hash;
      },
      set hash(value: string) {
        hash = value.startsWith("#") ? value : `#${value}`;
        listeners.get("hashchange")?.forEach((l) => l());
      },
      origin: "https://wixy.test",
    },
    addEventListener: (type: string, listener: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
  };
  return win as unknown as Window;
}

function fakeState(overrides: Partial<StateResponse> = {}): StateResponse {
  return {
    project: { slug: "ca", name: "Cottage Aesthetics", domain: "ca.example" },
    pages: [
      {
        slug: "index",
        meta: { title: "Home", navLabel: "Home", inNav: true, navOrder: 10 },
        lastModified: null,
      },
      {
        slug: "about",
        meta: { title: "About", navLabel: "About", inNav: true, navOrder: 20 },
        lastModified: null,
      },
    ],
    draft: { rev: 0, opCount: 0 },
    live: null,
    upstream: { aheadOfPublished: [], fetchedAt: null },
    publishJob: null,
    chats: [],
    ...overrides,
  };
}

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    getState: vi.fn(async () => fakeState()),
    getContent: vi.fn(async () => ({ content: {}, bindings: { page: "index", fields: [] } })),
    patchDraft: vi.fn(async () => ({ kind: "ok" as const, rev: 1 })),
    discardDraft: vi.fn(async () => ({ rev: 0 })),
    getMedia: vi.fn(async () => []),
    uploadMedia: vi.fn(),
    deleteMedia: vi.fn(),
    getTheme: vi.fn(async () => ({
      colors: { cream: "#F1E8D9" },
      shadow: "0 18px 44px rgba(62,49,42,.14)",
      fonts: { serif: { family: "Cormorant Garamond", weights: ["400"], italics: true } },
    })),
    ...overrides,
  } as AdminApi;
}

interface FakeEditViewHandle {
  mountedPages: string[];
  setPageCalls: string[];
  teardownCount: number;
  applyOpsCalls: DraftOp[][];
  lastDeps: MountEditViewDeps | null;
  fn: (page: string, deps: MountEditViewDeps) => EditView;
}

function fakeMountEditView(): FakeEditViewHandle {
  const handle: FakeEditViewHandle = {
    mountedPages: [],
    setPageCalls: [],
    teardownCount: 0,
    applyOpsCalls: [],
    lastDeps: null,
    fn: (page, deps) => {
      handle.mountedPages.push(page);
      handle.lastDeps = deps;
      return {
        element: document.createElement("div"),
        setPage: (p) => handle.setPageCalls.push(p),
        applyOps: (ops) => handle.applyOpsCalls.push(ops),
        postMessage: () => {},
        teardown: () => {
          handle.teardownCount += 1;
        },
      };
    },
  };
  return handle;
}

async function flushState(api: AdminApi): Promise<void> {
  const mock = api.getState as ReturnType<typeof vi.fn>;
  await mock.mock.results[mock.mock.results.length - 1]?.value;
  await Promise.resolve();
}

describe("mountShell", () => {
  it("paints shell chrome synchronously, then hydrates the top bar from state", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");

    mountShell(container, { api, win, mountEditView: fakeMountEditView().fn });
    expect(container.querySelector(".wx-topbar")).not.toBeNull(); // synchronous paint

    await flushState(api);
    expect(container.querySelector(".wx-topbar-title")?.textContent).toBe("Wixy · Cottage Aesthetics");
    expect(container.querySelector(".wx-draft-chip")?.textContent).toBe("0 changes");
  });

  it("defaults to the pages panel and lists fetched pages", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");

    mountShell(container, { api, win, mountEditView: fakeMountEditView().fn });
    await flushState(api);

    const rows = container.querySelectorAll(".wx-pages-table tbody tr");
    expect(rows).toHaveLength(2);
  });

  it("clicking Edit navigates to #/edit/<slug> and mounts the edit view", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");
    const editView = fakeMountEditView();

    mountShell(container, { api, win, mountEditView: editView.fn });
    await flushState(api);

    container.querySelectorAll<HTMLButtonElement>(".wx-pages-edit")[1]?.click();

    expect(win.location.hash).toBe("#/edit/about");
    expect(editView.mountedPages).toEqual(["about"]);
    expect(container.querySelector(".wx-edit-wrap")).not.toBeNull();
    expect(container.querySelector(".wx-page-settings-trigger")).not.toBeNull();
  });

  it("navigating between two edit pages reuses the mounted view via setPage", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");
    const editView = fakeMountEditView();

    mountShell(container, { api, win, mountEditView: editView.fn });
    await flushState(api);

    win.location.hash = "#/edit/index";
    win.location.hash = "#/edit/about";

    expect(editView.mountedPages).toEqual(["index"]);
    expect(editView.setPageCalls).toEqual(["about"]);
    expect(editView.teardownCount).toBe(0);
  });

  it("navigating away from edit mode tears down the edit view", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");
    const editView = fakeMountEditView();

    mountShell(container, { api, win, mountEditView: editView.fn });
    await flushState(api);

    win.location.hash = "#/edit/index";
    win.location.hash = "#/pages";

    expect(editView.teardownCount).toBe(1);
    expect(container.querySelector(".wx-pages-table")).not.toBeNull();
  });

  it("a stub nav route (e.g. History) renders a coming-soon panel", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");

    mountShell(container, { api, win, mountEditView: fakeMountEditView().fn });
    await flushState(api);

    win.location.hash = "#/history";
    expect(container.querySelector(".wx-coming-soon")?.textContent).toMatch(/later milestone/i);
  });

  it("#/media mounts the real media panel", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");

    mountShell(container, { api, win, mountEditView: fakeMountEditView().fn });
    await flushState(api);

    win.location.hash = "#/media";
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector(".wx-media-panel")).not.toBeNull();
    expect(container.querySelector(".wx-coming-soon")).toBeNull();
  });

  it("#/theme mounts the real theme panel, reusing the injected mountEditView", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");
    const editView = fakeMountEditView();

    mountShell(container, { api, win, mountEditView: editView.fn });
    await flushState(api);

    win.location.hash = "#/theme";
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector(".wx-theme-panel")).not.toBeNull();
    expect(container.querySelector(".wx-coming-soon")).toBeNull();
    expect(editView.mountedPages).toEqual(["index"]);
  });

  it("switching away from #/theme tears down its embedded preview iframe", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");
    const editView = fakeMountEditView();

    mountShell(container, { api, win, mountEditView: editView.fn });
    await flushState(api);

    win.location.hash = "#/theme";
    await Promise.resolve();
    await Promise.resolve();
    win.location.hash = "#/pages";

    expect(editView.teardownCount).toBe(1);
  });

  it("shows a persistent error toast when the initial state fetch fails, and clears it on success", async () => {
    let shouldFail = true;
    const api = fakeApi({
      getState: vi.fn(async () => {
        if (shouldFail) throw new Error("network down");
        return fakeState();
      }),
    });
    const win = fakeWindow();
    const container = document.createElement("div");

    vi.useFakeTimers();
    try {
      mountShell(container, { api, win, mountEditView: fakeMountEditView().fn });
      const getStateMock = api.getState as ReturnType<typeof vi.fn>;
      await getStateMock.mock.results[0]?.value.catch(() => undefined);
      await Promise.resolve();
      expect(container.querySelector(".wx-toast-error")).not.toBeNull();

      shouldFail = false;
      await vi.runOnlyPendingTimersAsync(); // fires the scheduled retry
      await Promise.resolve();

      expect(container.querySelector(".wx-toast-error")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an accepted PATCH batch forwards applyOps to the active edit view", async () => {
    const api = fakeApi({ patchDraft: vi.fn(async () => ({ kind: "ok" as const, rev: 1 })) });
    const win = fakeWindow();
    const container = document.createElement("div");
    const editView = fakeMountEditView();

    mountShell(container, { api, win, mountEditView: editView.fn });
    await flushState(api);
    win.location.hash = "#/edit/index";

    // Drive the SAME OpQueue the shell constructed and handed to the edit view
    // (spec/05 §2: "the shell owns state") — this is how a real edit view's
    // message handler would report an overlay `op`.
    const opQueue = editView.lastDeps?.opQueue;
    if (opQueue === undefined) throw new Error("edit view was not mounted with an opQueue");

    vi.useFakeTimers();
    try {
      opQueue.enqueue({ file: "index", path: "hero.title", value: "New" });
      // OpQueue coalesces at 300ms (opQueue.ts's DEFAULT_COALESCE_MS) before
      // sending — run all fake timers to get through that delay and the
      // resulting patchDraft()/onAccepted promise chain.
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }

    expect(editView.applyOpsCalls).toEqual([[{ file: "index", path: "hero.title", value: "New" }]]);
  });
});
