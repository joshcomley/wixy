import { describe, expect, it, vi } from "vitest";
import { mountShell } from "../src/shell";
import type { Shell } from "../src/shell";
import type { AdminApi, StateResponse } from "../src/api";
import type { ChatPanel, ChatPanelDeps } from "../src/chatPanel";
import type { EditView, MountEditViewDeps } from "../src/editView";
import type { DraftOp } from "../src/protocol";

function fakeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

/** `storage` is an explicit param (rather than always fresh) so a test can
 * share one across two separate `fakeWindow()` calls — simulating a fresh
 * page load reusing the same browser's localStorage (see the last-active-
 * route restore test below). `getDisplayMedia` defaults to "unsupported"
 * (undefined) — screenshot.test.ts already covers captureScreenshot's own
 * logic in depth; shell-level tests only need to confirm the click ->
 * captureScreenshot -> toast wiring, which the "unsupported" path exercises
 * without needing a fake <video>/<canvas>. */
function fakeWindow(
  opts: {
    storage?: Storage;
    initialHash?: string;
    getDisplayMedia?: (options: unknown) => Promise<MediaStream>;
    /** When true the fake carries a minimal `document` (visibilityState +
     * listener registry) so the shell's visibility-revalidation wiring can be
     * exercised — the default fake omits it and the shell capability-guards
     * it off. */
    withDocument?: boolean;
  } = {},
): Window {
  const listeners = new Map<string, Set<(e?: Event) => void>>();
  let hash = opts.initialHash ?? "";
  const docListeners = new Map<string, Set<() => void>>();
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
    localStorage: opts.storage ?? fakeStorage(),
    navigator: {
      mediaDevices: opts.getDisplayMedia === undefined ? undefined : { getDisplayMedia: opts.getDisplayMedia },
      clipboard: undefined,
    },
    addEventListener: (type: string, listener: (e?: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener: (type: string, listener: (e?: Event) => void) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: Event) => {
      listeners.get(event.type)?.forEach((l) => l(event));
      return true;
    },
    confirm: () => true,
    ...(opts.withDocument === true
      ? {
          document: {
            visibilityState: "visible",
            addEventListener: (type: string, listener: () => void) => {
              if (!docListeners.has(type)) docListeners.set(type, new Set());
              docListeners.get(type)?.add(listener);
            },
            removeEventListener: (type: string, listener: () => void) => {
              docListeners.get(type)?.delete(listener);
            },
            dispatchEvent: (event: Event) => {
              docListeners.get(event.type)?.forEach((l) => l());
              return true;
            },
          },
        }
      : {}),
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
        editable: true,
        pendingDelete: false,
      },
      {
        slug: "about",
        meta: { title: "About", navLabel: "About", inNav: true, navOrder: 20 },
        lastModified: null,
        editable: true,
        pendingDelete: false,
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
    getPublishPreview: vi.fn(async () => ({ changes: {}, validate: { ok: true, errors: [] } })),
    publish: vi.fn(async () => ({ kind: "ok" as const, version: 1, sha: "a".repeat(40) })),
    getPublishes: vi.fn(async () => []),
    restore: vi.fn(async () => ({ kind: "ok" as const, version: 1, sha: "a".repeat(40), of: 0 })),
    duplicatePage: vi.fn(async () => ({ ok: true as const })),
    deletePage: vi.fn(async () => ({ ok: true as const })),
    createConversation: vi.fn(async () => ({
      convId: "c1",
      title: "New conversation",
      createdAt: "2026-07-10T00:00:00Z",
      status: "pending" as const,
      failureReason: null,
      failureMessage: null,
    })),
    getConversations: vi.fn(async () => []),
    sendMessage: vi.fn(async () => ({ accepted: true, buffered: false })),
    renameConversation: vi.fn(async () => ({
      convId: "c1",
      title: "renamed",
      createdAt: "2026-07-10T00:00:00Z",
      status: "ready" as const,
      failureReason: null,
      failureMessage: null,
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
      const element = document.createElement("div");
      // The real mountEditView inserts toolbar extras into its toolbar row —
      // the fake must mount them too, or reparenting expectations (the draft
      // chip moving into/out of the slim bar) can't observe them.
      const toolbar = document.createElement("div");
      toolbar.className = "wx-device-toolbar";
      toolbar.append(...(deps.toolbarLeading ?? []), ...(deps.toolbarTrailing ?? []));
      element.appendChild(toolbar);
      return {
        element,
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

interface FakeChatPanelHandle {
  mountedConversations: Array<string | null>;
  teardownCount: number;
  fn: (conversation: string | null, deps: ChatPanelDeps) => ChatPanel;
}

/** Real `mountChatPanel` opens a genuine `EventSource` (spec/06 §1's live
 * stream) the instant a conversation view mounts — jsdom doesn't implement
 * it, so shell tests that need to mount `#/chat/<conv>` inject this instead,
 * mirroring `fakeMountEditView`'s own reason for existing (a real iframe). */
function fakeMountChatPanel(): FakeChatPanelHandle {
  const handle: FakeChatPanelHandle = {
    mountedConversations: [],
    teardownCount: 0,
    fn: (conversation) => {
      handle.mountedConversations.push(conversation);
      return {
        element: document.createElement("div"),
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
    expect(container.querySelector(".wx-draft-chip")?.textContent).toBe("No unpublished changes");
  });

  it("the chip counts unpublished changes and outside site updates in layman wording", async () => {
    const api = fakeApi({
      getState: vi.fn(async () =>
        fakeState({
          draft: { rev: 0, opCount: 6 },
          upstream: {
            aheadOfPublished: [
              { sha: "a".repeat(40), subject: "one", author: "AI", when: "2026-01-01" },
              { sha: "b".repeat(40), subject: "two", author: "AI", when: "2026-01-02" },
            ],
            fetchedAt: null,
          },
        }),
      ),
    });
    const win = fakeWindow();
    const container = document.createElement("div");

    mountShell(container, { api, win, mountEditView: fakeMountEditView().fn });
    await flushState(api);

    expect(container.querySelector(".wx-draft-chip")?.textContent).toBe(
      "6 unpublished changes · 2 site updates",
    );
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
    // The Settings button lives in the slim edit bar, handed to the edit view
    // as trailing toolbar content (decisions/00076).
    const trailing = editView.lastDeps?.toolbarTrailing ?? [];
    expect(trailing.some((el) => el.classList.contains("wx-page-settings-trigger"))).toBe(true);
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

  describe("edit-view chrome (decisions/00076)", () => {
    it("the edit route adds wx-shell-editing to the shell; leaving removes it", async () => {
      const api = fakeApi();
      const win = fakeWindow();
      const container = document.createElement("div");

      mountShell(container, { api, win, mountEditView: fakeMountEditView().fn });
      await flushState(api);

      expect(container.classList.contains("wx-shell-editing")).toBe(false);
      win.location.hash = "#/edit/index";
      await Promise.resolve();
      expect(container.classList.contains("wx-shell-editing")).toBe(true);
      win.location.hash = "#/pages";
      await Promise.resolve();
      expect(container.classList.contains("wx-shell-editing")).toBe(false);
    });

    it("passes a slim-bar back button, the draft chip, Settings, and reveal button to the edit view", async () => {
      const api = fakeApi();
      const win = fakeWindow();
      const container = document.createElement("div");
      const editView = fakeMountEditView();

      mountShell(container, { api, win, mountEditView: editView.fn });
      await flushState(api);
      win.location.hash = "#/edit/index";
      await Promise.resolve();

      const deps = editView.lastDeps;
      expect(deps).not.toBeNull();
      const leading = deps?.toolbarLeading ?? [];
      const trailing = deps?.toolbarTrailing ?? [];
      expect(leading[0]?.className).toBe("wx-edit-back");
      expect(leading[0]?.getAttribute("aria-label")).toBe("Back to pages");
      // The draft chip relocates into the slim bar while editing — the only
      // publish trigger with the topbar hidden (decisions/00076).
      expect(trailing[0]?.className).toBe("wx-draft-chip");
      expect(trailing[1]?.className).toBe("wx-page-settings-trigger");
      expect(trailing[1]?.textContent).toBe("Settings");
      expect(trailing[2]?.className).toBe("wx-chrome-reveal");
    });

    it("the draft chip moves back to the topbar when leaving edit view", async () => {
      const api = fakeApi();
      const win = fakeWindow();
      const container = document.createElement("div");

      mountShell(container, { api, win, mountEditView: fakeMountEditView().fn });
      await flushState(api);
      win.location.hash = "#/edit/index";
      await Promise.resolve();
      const chip = container.querySelector(".wx-draft-chip");
      expect(chip?.closest(".wx-topbar")).toBeNull();

      win.location.hash = "#/pages";
      await Promise.resolve();
      expect(container.querySelector(".wx-draft-chip")?.closest(".wx-topbar")).not.toBeNull();
    });

    it("the slim-bar back button navigates to the pages list", async () => {
      const api = fakeApi();
      const win = fakeWindow();
      const container = document.createElement("div");
      const editView = fakeMountEditView();

      mountShell(container, { api, win, mountEditView: editView.fn });
      await flushState(api);
      win.location.hash = "#/edit/index";
      await Promise.resolve();

      editView.lastDeps?.toolbarLeading?.[0]?.click();
      expect(win.location.hash).toBe("#/pages");
    });

    it("the reveal button shows the chrome and it auto-hides after 10 seconds", async () => {
      vi.useFakeTimers();
      try {
        const api = fakeApi();
        const win = fakeWindow();
        const container = document.createElement("div");
        const editView = fakeMountEditView();

        mountShell(container, { api, win, mountEditView: editView.fn });
        await flushState(api);
        win.location.hash = "#/edit/index";
        await Promise.resolve();

        const reveal = editView.lastDeps?.toolbarTrailing?.[2];
        expect(container.classList.contains("wx-shell-chrome-revealed")).toBe(false);
        reveal?.click();
        expect(container.classList.contains("wx-shell-chrome-revealed")).toBe(true);

        vi.advanceTimersByTime(9_500);
        expect(container.classList.contains("wx-shell-chrome-revealed")).toBe(true);
        vi.advanceTimersByTime(600);
        expect(container.classList.contains("wx-shell-chrome-revealed")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a route change clears a revealed chrome", async () => {
      const api = fakeApi();
      const win = fakeWindow();
      const container = document.createElement("div");
      const editView = fakeMountEditView();

      mountShell(container, { api, win, mountEditView: editView.fn });
      await flushState(api);
      win.location.hash = "#/edit/index";
      await Promise.resolve();

      editView.lastDeps?.toolbarTrailing?.[2]?.click();
      expect(container.classList.contains("wx-shell-chrome-revealed")).toBe(true);
      win.location.hash = "#/pages";
      await Promise.resolve();
      expect(container.classList.contains("wx-shell-chrome-revealed")).toBe(false);
    });
  });

  it("#/chat mounts the real chat panel (list view), not a stub", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");

    mountShell(container, { api, win, mountEditView: fakeMountEditView().fn });
    await flushState(api);

    win.location.hash = "#/chat";
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector(".wx-chat-list-view")).not.toBeNull();
    expect(container.querySelector(".wx-coming-soon")).toBeNull();
    expect(api.getConversations).toHaveBeenCalled();
  });

  it("#/chat/<conv> passes the conversation id through to the chat panel mount", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");
    const chatPanel = fakeMountChatPanel();

    mountShell(container, {
      api,
      win,
      mountEditView: fakeMountEditView().fn,
      mountChatPanel: chatPanel.fn,
    });
    await flushState(api);

    win.location.hash = "#/chat/c1";
    await Promise.resolve();
    await Promise.resolve();

    expect(chatPanel.mountedConversations).toEqual(["c1"]);
  });

  it("navigating away from a conversation tears down the chat panel", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");
    const chatPanel = fakeMountChatPanel();

    mountShell(container, {
      api,
      win,
      mountEditView: fakeMountEditView().fn,
      mountChatPanel: chatPanel.fn,
    });
    await flushState(api);

    win.location.hash = "#/chat/c1";
    win.location.hash = "#/pages";

    expect(chatPanel.teardownCount).toBe(1);
  });

  it("the History route renders the real history panel, not a stub", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");

    mountShell(container, { api, win, mountEditView: fakeMountEditView().fn });
    await flushState(api);

    win.location.hash = "#/history";
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector(".wx-coming-soon")).toBeNull();
    expect(container.querySelector(".wx-history-panel")).not.toBeNull();
    expect(api.getPublishes).toHaveBeenCalled();
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

  it("clicking the Publish button opens the publish drawer", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");

    mountShell(container, { api, win });
    await flushState(api);

    container.querySelector<HTMLButtonElement>(".wx-publish-button")?.click();
    await Promise.resolve();

    expect(container.querySelector(".wx-drawer-wide")).not.toBeNull();
    expect(api.getPublishPreview).toHaveBeenCalled();
  });

  it("clicking the draft-status chip also opens the publish drawer", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");

    mountShell(container, { api, win });
    await flushState(api);

    container.querySelector<HTMLButtonElement>(".wx-draft-chip")?.click();
    await Promise.resolve();

    expect(container.querySelector(".wx-drawer-wide")).not.toBeNull();
  });

  it("the Publish button and chip are disabled while a publish is already running", async () => {
    const api = fakeApi({
      getState: vi.fn(async () =>
        fakeState({
          publishJob: {
            id: "job-1",
            stage: "building",
            log: [],
            version: null,
            error: null,
            isRunning: true,
          },
        }),
      ),
    });
    const win = fakeWindow();
    const container = document.createElement("div");

    mountShell(container, { api, win });
    await flushState(api);

    const publishButton = container.querySelector<HTMLButtonElement>(".wx-publish-button");
    const chip = container.querySelector<HTMLButtonElement>(".wx-draft-chip");
    expect(publishButton?.disabled).toBe(true);
    expect(chip?.disabled).toBe(true);
  });

  it("opening the publish drawer while page settings is open switches to it", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");
    const editView = fakeMountEditView();

    mountShell(container, { api, win, mountEditView: editView.fn });
    await flushState(api);
    win.location.hash = "#/edit/index";
    await Promise.resolve();

    // The Settings trigger is handed to the edit view's toolbar (decisions/00076) —
    // trailing order is [draft chip, Settings, reveal].
    editView.lastDeps?.toolbarTrailing?.[1]?.click();
    await Promise.resolve();
    expect(container.querySelectorAll(".wx-drawer")).toHaveLength(1);
    expect(container.querySelector(".wx-drawer-wide")).toBeNull();

    container.querySelector<HTMLButtonElement>(".wx-publish-button")?.click();
    await Promise.resolve();
    expect(container.querySelectorAll(".wx-drawer")).toHaveLength(1);
    expect(container.querySelector(".wx-drawer-wide")).not.toBeNull();
  });

  it("keeps the publish drawer open when the tab regains visibility on the pages route", async () => {
    // Operator report 2026-07-21: reviewing changes, switching to another
    // Chrome tab and back kicked the user out of the review. The shell's
    // visibility revalidation re-renders the mounted pages panel from the
    // fresh snapshot — a same-route re-render, not a navigation — so it must
    // not close the drawer (decisions/00081).
    const api = fakeApi({ getServerCommit: vi.fn(async () => null) } as Partial<AdminApi>);
    const win = fakeWindow({ withDocument: true });
    const container = document.createElement("div");

    mountShell(container, { api, win });
    await flushState(api);

    container.querySelector<HTMLButtonElement>(".wx-draft-chip")?.click();
    await Promise.resolve();
    expect(container.querySelector(".wx-drawer-wide")).not.toBeNull();

    win.document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 0)); // drain revalidate's awaits
    await flushState(api);

    expect(container.querySelector(".wx-drawer-wide")).not.toBeNull();
    expect(api.getServerCommit).toHaveBeenCalled(); // the revalidation genuinely ran
  });

  it("still closes the publish drawer on a genuine route change", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");

    mountShell(container, { api, win });
    await flushState(api);

    container.querySelector<HTMLButtonElement>(".wx-draft-chip")?.click();
    await Promise.resolve();
    expect(container.querySelector(".wx-drawer-wide")).not.toBeNull();

    win.location.hash = "#/history";
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector(".wx-drawer-wide")).toBeNull();
  });

  it("the settings toggle navigates to #/settings and mounts the real settings panel", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");

    mountShell(container, { api, win, mountEditView: fakeMountEditView().fn });
    await flushState(api);

    container.querySelector<HTMLButtonElement>(".wx-settings-toggle")?.click();
    await Promise.resolve();

    expect(win.location.hash).toBe("#/settings");
    expect(container.querySelector(".wx-settings-panel")).not.toBeNull();
    expect(container.querySelector(".wx-coming-soon")).toBeNull();
  });

  it("#/settings/shortcuts mounts the Keyboard Shortcuts sub-page", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");

    mountShell(container, { api, win, mountEditView: fakeMountEditView().fn });
    await flushState(api);

    win.location.hash = "#/settings/shortcuts";
    await Promise.resolve();

    expect(container.querySelector(".wx-settings-shortcuts")).not.toBeNull();
  });

  it("Ctrl+Plus zooms in through the full stack (shortcuts.ts -> zoomController -> topbar label)", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");

    mountShell(container, { api, win, mountEditView: fakeMountEditView().fn });
    await flushState(api);

    win.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, code: "Equal" }));

    expect(container.querySelector(".wx-zoom-level")?.textContent).toBe("110%");
  });

  it("restores the last-active route on a fresh mount when the hash is empty, and an explicit hash still wins", async () => {
    const storage = fakeStorage();
    const api = fakeApi();

    const win1 = fakeWindow({ storage });
    const container1 = document.createElement("div");
    mountShell(container1, { api, win: win1, mountEditView: fakeMountEditView().fn });
    await flushState(api);
    win1.location.hash = "#/media";
    await Promise.resolve();

    // Fresh "reload": a new shell, same storage, no hash.
    const win2 = fakeWindow({ storage });
    const container2 = document.createElement("div");
    mountShell(container2, { api, win: win2, mountEditView: fakeMountEditView().fn });
    await flushState(api);

    expect(win2.location.hash).toBe("#/media");
    expect(container2.querySelector(".wx-media-panel")).not.toBeNull();

    // A THIRD "reload" with an explicit deep-link hash must win over the
    // persisted route (normal web navigation expectations).
    const win3 = fakeWindow({ storage, initialHash: "#/history" });
    const container3 = document.createElement("div");
    mountShell(container3, { api, win: win3, mountEditView: fakeMountEditView().fn });
    await flushState(api);

    expect(win3.location.hash).toBe("#/history");
    expect(container3.querySelector(".wx-history-panel")).not.toBeNull();
  });

  it("clicking the screenshot button when capture is unsupported shows an error toast", async () => {
    const api = fakeApi();
    const win = fakeWindow(); // no getDisplayMedia -> "unsupported"
    const container = document.createElement("div");

    mountShell(container, { api, win, mountEditView: fakeMountEditView().fn });
    await flushState(api);

    container.querySelector<HTMLButtonElement>(".wx-screenshot-button")?.click();
    await Promise.resolve();
    await Promise.resolve();

    const toast = container.querySelector(".wx-toast-error");
    expect(toast?.textContent).toBe("Screenshot capture isn't supported in this browser.");
  });

  it("a denied/cancelled capture shows no toast (matches cancelling any other native dialog elsewhere in the app)", async () => {
    const api = fakeApi();
    const win = fakeWindow({ getDisplayMedia: () => Promise.reject(new Error("NotAllowedError")) });
    const container = document.createElement("div");

    mountShell(container, { api, win, mountEditView: fakeMountEditView().fn });
    await flushState(api);

    container.querySelector<HTMLButtonElement>(".wx-screenshot-button")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector(".wx-toast-error")).toBeNull();
  });

  it("the screenshot button re-enables after a capture attempt completes", async () => {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");

    mountShell(container, { api, win, mountEditView: fakeMountEditView().fn });
    await flushState(api);

    const button = container.querySelector<HTMLButtonElement>(".wx-screenshot-button")!;
    button.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(button.disabled).toBe(false);
  });
});

describe("mountShell — topbar overflow menu (narrow viewports)", () => {
  /** The narrow-viewport stylesheet collapses the topbar's secondary controls
   * (zoom, font scale, screenshot, theme, settings) into a popover behind the
   * ⋯ trigger; these tests pin the behavior, not the pixels. The container is
   * attached to document.body so clicks bubble to the document the way they
   * do live (the outside-click listener is document-level). */

  function mountWithOverflow(): {
    container: HTMLElement;
    secondary: HTMLElement;
    trigger: HTMLButtonElement;
    shell: Shell;
    win: Window;
  } {
    const api = fakeApi();
    const win = fakeWindow();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const shell = mountShell(container, { api, win, mountEditView: fakeMountEditView().fn });
    const secondary = container.querySelector<HTMLElement>(".wx-topbar-secondary")!;
    const trigger = container.querySelector<HTMLButtonElement>(".wx-topbar-overflow")!;
    return { container, secondary, trigger, shell, win };
  }

  it("wraps the five secondary controls and toggles the popover via the ⋯ trigger", async () => {
    const { container, secondary, trigger, shell } = mountWithOverflow();
    await Promise.resolve();

    expect(secondary).not.toBeNull();
    expect(trigger).not.toBeNull();
    for (const sel of [
      ".wx-site-link",
      ".wx-zoom-controls",
      ".wx-font-scale-controls",
      ".wx-screenshot-button",
      ".wx-theme-toggle",
      ".wx-settings-toggle",
    ]) {
      expect(secondary.querySelector(sel), sel).not.toBeNull();
    }
    expect(secondary.classList.contains("wx-topbar-secondary-open")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    trigger.click();
    expect(secondary.classList.contains("wx-topbar-secondary-open")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    trigger.click();
    expect(secondary.classList.contains("wx-topbar-secondary-open")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    shell.teardown();
    container.remove();
  });

  it("stays open for clicks inside the popover, closes on an outside click and on Escape", async () => {
    const { container, secondary, trigger, shell, win } = mountWithOverflow();
    await Promise.resolve();

    trigger.click();
    secondary.querySelector<HTMLButtonElement>(".wx-zoom-button")!.click();
    expect(secondary.classList.contains("wx-topbar-secondary-open")).toBe(true);

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(secondary.classList.contains("wx-topbar-secondary-open")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    trigger.click();
    expect(secondary.classList.contains("wx-topbar-secondary-open")).toBe(true);
    win.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(secondary.classList.contains("wx-topbar-secondary-open")).toBe(false);

    shell.teardown();
    container.remove();
  });
});
