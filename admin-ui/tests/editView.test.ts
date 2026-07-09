import { describe, expect, it, vi } from "vitest";
import { createEditViewCore, type OpQueueLike } from "../src/editView";
import type { AdminApi, ContentResponse } from "../src/api";
import type { PageBindings, ShellToOverlayMessage } from "../src/protocol";

const BINDINGS: PageBindings = { page: "about", fields: [{ key: "hero.title", kind: "text" }] };

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    getState: vi.fn(),
    getContent: vi.fn(async (): Promise<ContentResponse> => ({ content: {}, bindings: BINDINGS })),
    patchDraft: vi.fn(),
    discardDraft: vi.fn(),
    getMedia: vi.fn(),
    ...overrides,
  } as AdminApi;
}

function fakeQueue(rev = 0): OpQueueLike & { enqueued: unknown[] } {
  const enqueued: unknown[] = [];
  return {
    rev,
    enqueued,
    enqueue: (op) => enqueued.push(op),
  };
}

interface HarnessOverrides {
  api?: AdminApi;
  opQueue?: OpQueueLike & { enqueued: unknown[] };
}

function harness(overrides: HarnessOverrides = {}) {
  const sent: ShellToOverlayMessage[] = [];
  const loaded: string[] = [];
  const navigated: string[] = [];
  const api = overrides.api ?? fakeApi();
  const opQueue = overrides.opQueue ?? fakeQueue();
  const core = createEditViewCore("about", {
    api,
    opQueue,
    postToOverlay: (message) => sent.push(message),
    loadPage: (page) => loaded.push(page),
    onOverlayNavigated: (page) => navigated.push(page),
  });
  return { core, sent, loaded, navigated, api, opQueue };
}

describe("createEditViewCore", () => {
  it("on ready, fetches content and sends init with the current queue rev", async () => {
    const { core, sent, api } = harness({ opQueue: fakeQueue(7) });
    core.handleMessage({ wx: 1, type: "ready" });

    // Await the mock's ACTUAL returned promise (not a guessed number of
    // Promise.resolve() ticks) so this doesn't depend on exact microtask
    // scheduling: one tick for it to resolve, one more for requestInit's
    // .then() callback (attached before this await) to run off the back of it.
    const getContentMock = api.getContent as ReturnType<typeof vi.fn>;
    await getContentMock.mock.results[0]?.value;
    await Promise.resolve();

    expect(api.getContent).toHaveBeenCalledWith("about");
    expect(sent).toEqual([{ wx: 1, type: "init", page: "about", bindings: BINDINGS, draftRev: 7 }]);
  });

  it("enqueues an op message into the queue", () => {
    const { core, opQueue } = harness();
    core.handleMessage({ wx: 1, type: "op", file: "about", path: "hero.title", value: "New" });
    expect(opQueue.enqueued).toEqual([{ file: "about", path: "hero.title", value: "New" }]);
  });

  it("ignores an unrecognized message", () => {
    const { core, sent, opQueue } = harness();
    core.handleMessage({ wx: 1, type: "selected", key: "x", kind: "text", rect: { x: 0, y: 0, width: 1, height: 1 } });
    core.handleMessage({ wx: 1, type: "mediaRequest", key: "x" });
    core.handleMessage("not even an object");
    expect(sent).toEqual([]);
    expect(opQueue.enqueued).toEqual([]);
  });

  it("on navigate, updates currentPage and notifies onOverlayNavigated without calling loadPage", () => {
    const { core, loaded, navigated } = harness();
    core.handleMessage({ wx: 1, type: "navigate", page: "contact" });
    expect(core.currentPage).toBe("contact");
    expect(navigated).toEqual(["contact"]);
    expect(loaded).toEqual([]);
  });

  it("setPage loads a different page", () => {
    const { core, loaded } = harness();
    core.setPage("contact");
    expect(core.currentPage).toBe("contact");
    expect(loaded).toEqual(["contact"]);
  });

  it("setPage is a no-op when already on that page", () => {
    const { core, loaded } = harness();
    core.setPage("about");
    expect(loaded).toEqual([]);
  });

  it("a ready superseded by a later navigation before its content fetch resolves does not send a stale init", async () => {
    const deferred: { resolve: (value: ContentResponse) => void } = {
      resolve: () => {
        throw new Error("resolve not yet assigned");
      },
    };
    const contentPromise = new Promise<ContentResponse>((resolve) => {
      deferred.resolve = resolve;
    });
    const api = fakeApi({ getContent: vi.fn(() => contentPromise) });
    const { core, sent } = harness({ api });

    core.handleMessage({ wx: 1, type: "ready" }); // starts the (slow) fetch for "about"
    core.setPage("contact"); // supersedes it before the fetch resolves

    deferred.resolve({ content: {}, bindings: BINDINGS });
    await contentPromise;
    await Promise.resolve(); // let requestInit's .then() callback run

    expect(sent).toEqual([]);
  });
});
