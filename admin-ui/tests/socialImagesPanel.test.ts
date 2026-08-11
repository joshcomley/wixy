import { describe, expect, it, vi } from "vitest";
import { mountSocialImagesPanel } from "../src/socialImagesPanel";
import type { AdminApi, ContentResponse, MediaItem, PageSummary } from "../src/api";
import type { OpQueueLike } from "../src/editView";

const PAGES: PageSummary[] = [
  { slug: "index", meta: { navLabel: "Home" }, lastModified: null, editable: true, pendingDelete: false },
  { slug: "about", meta: { navLabel: "About" }, lastModified: null, editable: true, pendingDelete: false },
  { slug: "contact", meta: {}, lastModified: null, editable: true, pendingDelete: false },
];

const CONTENT: Record<string, ContentResponse> = {
  index: {
    content: { meta: { ogImage: { src: "images/lounge.jpg", alt: "Lounge" } } },
    bindings: { page: "index", fields: [] },
  },
  about: {
    content: { meta: {} },
    bindings: { page: "about", fields: [] },
  },
};

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    getState: vi.fn(),
    getContent: vi.fn(
      async (page: string): Promise<ContentResponse> => {
        if (page === "contact") throw new Error("boom");
        const found = CONTENT[page];
        if (found === undefined) throw new Error(`no fixture content for '${page}'`);
        return found;
      },
    ),
    patchDraft: vi.fn(),
    discardDraft: vi.fn(),
    getMedia: vi.fn(async (): Promise<MediaItem[]> => []),
    uploadMedia: vi.fn(),
    deleteMedia: vi.fn(),
    ...overrides,
  } as AdminApi;
}

function fakeQueue(): OpQueueLike & { enqueued: unknown[] } {
  const enqueued: unknown[] = [];
  return {
    rev: 0,
    enqueued,
    enqueue: (op) => enqueued.push(op),
    flushNow: async () => {},
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function rowFor(el: HTMLElement, slug: string): HTMLElement {
  const row = el.querySelector<HTMLElement>(`tr[data-slug="${slug}"]`);
  if (row === null) throw new Error(`no row for '${slug}'`);
  return row;
}

describe("mountSocialImagesPanel", () => {
  it("renders one row per page, each starting in a loading state", () => {
    const panel = mountSocialImagesPanel(PAGES, { api: fakeApi(), opQueue: fakeQueue() });
    const rows = panel.element.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(3);
    for (const slug of ["index", "about", "contact"]) {
      expect(rowFor(panel.element, slug).textContent).toContain("Loading…");
    }
  });

  it("falls back to the slug when navLabel is missing", () => {
    const panel = mountSocialImagesPanel(PAGES, { api: fakeApi(), opQueue: fakeQueue() });
    expect(rowFor(panel.element, "contact").textContent).toContain("contact");
  });

  it("shows the current image once content resolves, and 'No image selected' when there is none", async () => {
    const panel = mountSocialImagesPanel(PAGES, { api: fakeApi(), opQueue: fakeQueue() });
    await flush();

    const indexImg = rowFor(panel.element, "index").querySelector<HTMLImageElement>(
      ".wx-og-image-preview img",
    );
    expect(indexImg?.getAttribute("src")).toBe("/images/lounge.jpg");
    expect(indexImg?.alt).toBe("Lounge");

    expect(rowFor(panel.element, "about").querySelector(".wx-og-image-empty")?.textContent).toBe(
      "No image selected",
    );
  });

  it("a failed getContent for one page shows a per-row error without breaking the others", async () => {
    const panel = mountSocialImagesPanel(PAGES, { api: fakeApi(), opQueue: fakeQueue() });
    await flush();

    expect(rowFor(panel.element, "contact").querySelector(".wx-og-image-empty")?.textContent).toBe(
      "Couldn't load",
    );
    // The other rows still resolved normally.
    expect(
      rowFor(panel.element, "index").querySelector<HTMLImageElement>(".wx-og-image-preview img")
        ?.src,
    ).toContain("lounge.jpg");
  });

  it("per-row Choose image enqueues exactly one op scoped to that page and updates only that row", async () => {
    const item: MediaItem = {
      name: "purdi.jpg",
      url: "/images/purdi.jpg",
      contentSrc: "images/purdi.jpg",
      source: "repo",
      sizeBytes: 2048,
      width: 400,
      height: 300,
      references: [],
    };
    const api = fakeApi({ getMedia: vi.fn(async (): Promise<MediaItem[]> => [item]) });
    const opQueue = fakeQueue();
    const panel = mountSocialImagesPanel(PAGES, { api, opQueue });
    await flush();

    const aboutButton = Array.from(
      rowFor(panel.element, "about").querySelectorAll("button"),
    ).find((b) => b.textContent === "Choose image");
    aboutButton?.click();
    await flush();

    const dialog = document.querySelector(".wx-media-dialog-backdrop");
    expect(dialog).not.toBeNull();
    dialog?.querySelector<HTMLButtonElement>(".wx-media-thumb")?.click();
    const confirmButton = Array.from(dialog?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Use this image",
    );
    confirmButton?.click();

    expect(opQueue.enqueued).toEqual([
      { file: "about", path: "meta.ogImage", value: { src: "images/purdi.jpg", alt: "Purdi" } },
    ]);
    // The picked src is stored exactly as the media dialog returned it — repo-relative,
    // no leading slash (decisions/00095's publish-corruption incident).
    expect((opQueue.enqueued[0] as { value: { src: string } }).value.src).not.toMatch(/^\//);
    expect(document.querySelector(".wx-media-dialog-backdrop")).toBeNull();

    // Only the "about" row's preview updated — "index" is untouched.
    expect(
      rowFor(panel.element, "about").querySelector<HTMLImageElement>(".wx-og-image-preview img")
        ?.src,
    ).toContain("purdi.jpg");
    expect(
      rowFor(panel.element, "index").querySelector<HTMLImageElement>(".wx-og-image-preview img")
        ?.src,
    ).toContain("lounge.jpg");
  });

  it("bulk 'Use one image for all pages' enqueues one identical op per page and updates every row", async () => {
    const item: MediaItem = {
      name: "exterior.jpg",
      url: "/images/exterior.jpg",
      contentSrc: "images/exterior.jpg",
      source: "repo",
      sizeBytes: 4096,
      width: 800,
      height: 600,
      references: [],
    };
    const api = fakeApi({ getMedia: vi.fn(async (): Promise<MediaItem[]> => [item]) });
    const opQueue = fakeQueue();
    const panel = mountSocialImagesPanel(PAGES, { api, opQueue });
    await flush();

    const bulkButton = Array.from(panel.element.querySelectorAll("button")).find(
      (b) => b.textContent === "Use one image for all pages",
    );
    bulkButton?.click();
    await flush();

    const dialog = document.querySelector(".wx-media-dialog-backdrop");
    dialog?.querySelector<HTMLButtonElement>(".wx-media-thumb")?.click();
    const confirmButton = Array.from(dialog?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Use this image",
    );
    confirmButton?.click();

    expect(opQueue.enqueued).toEqual([
      { file: "index", path: "meta.ogImage", value: { src: "images/exterior.jpg", alt: "Exterior" } },
      { file: "about", path: "meta.ogImage", value: { src: "images/exterior.jpg", alt: "Exterior" } },
      { file: "contact", path: "meta.ogImage", value: { src: "images/exterior.jpg", alt: "Exterior" } },
    ]);
    for (const slug of ["index", "about", "contact"]) {
      expect(
        rowFor(panel.element, slug).querySelector<HTMLImageElement>(".wx-og-image-preview img")
          ?.src,
      ).toContain("exterior.jpg");
    }
  });

  it("mentions Publish in the helper line, like other admin surfaces", () => {
    const panel = mountSocialImagesPanel(PAGES, { api: fakeApi(), opQueue: fakeQueue() });
    expect(panel.element.querySelector(".wx-pages-hint")?.textContent).toMatch(/publish/i);
  });

  it("teardown before content resolves prevents the late render", async () => {
    const deferred: { resolve: (value: ContentResponse) => void } = {
      resolve: () => {
        throw new Error("resolve not yet assigned");
      },
    };
    const pending = new Promise<ContentResponse>((resolve) => {
      deferred.resolve = resolve;
    });
    const api = fakeApi({ getContent: vi.fn(() => pending) });
    const panel = mountSocialImagesPanel([PAGES[0]!], { api, opQueue: fakeQueue() });
    panel.teardown();
    deferred.resolve(CONTENT["index"]!);
    await pending;
    await flush();

    expect(rowFor(panel.element, "index").textContent).toContain("Loading…");
  });
});
