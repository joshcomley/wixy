import { describe, expect, it, vi } from "vitest";
import { mountPageSettingsDrawer, readMeta } from "../src/pageSettingsDrawer";
import type { AdminApi, ContentResponse, MediaItem } from "../src/api";
import type { OpQueueLike } from "../src/editView";

describe("readMeta", () => {
  it("reads every field from a well-formed meta object", () => {
    const meta = readMeta({
      meta: {
        title: "About",
        description: "About us",
        ogImage: { src: "images/hero.jpg", alt: "Hero" },
        navLabel: "About",
        inNav: true,
        navOrder: 20,
      },
    });
    expect(meta).toEqual({
      title: "About",
      description: "About us",
      ogImage: { src: "images/hero.jpg", alt: "Hero" },
      navLabel: "About",
      inNav: true,
      navOrder: 20,
    });
  });

  it("defaults missing fields to empty/falsy values, ogImage to null", () => {
    expect(readMeta({})).toEqual({
      title: "",
      description: "",
      ogImage: null,
      navLabel: "",
      inNav: false,
      navOrder: 0,
    });
  });

  it("tolerates a malformed meta (not an object)", () => {
    expect(readMeta({ meta: "not an object" })).toEqual({
      title: "",
      description: "",
      ogImage: null,
      navLabel: "",
      inNav: false,
      navOrder: 0,
    });
  });
});

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    getState: vi.fn(),
    getContent: vi.fn(
      async (): Promise<ContentResponse> => ({
        content: { meta: { title: "About", navLabel: "About", inNav: true, navOrder: 20 } },
        bindings: { page: "about", fields: [] },
      }),
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
  };
}

describe("mountPageSettingsDrawer", () => {
  it("shows a loading state before content resolves, then renders the fields", async () => {
    const api = fakeApi();
    const drawer = mountPageSettingsDrawer("about", { api, opQueue: fakeQueue(), onClose: vi.fn() });
    expect(drawer.element.querySelector(".wx-drawer-body")?.textContent).toBe("Loading…");

    await (api.getContent as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    await Promise.resolve();

    const titleInput = drawer.element.querySelector<HTMLInputElement>(".wx-field-row input");
    expect(titleInput?.value).toBe("About");
  });

  it("committing the title field enqueues a meta.title op", async () => {
    const api = fakeApi();
    const opQueue = fakeQueue();
    const drawer = mountPageSettingsDrawer("about", { api, opQueue, onClose: vi.fn() });
    await (api.getContent as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    await Promise.resolve();

    const titleInput = drawer.element.querySelector<HTMLInputElement>(".wx-field-row input");
    if (titleInput === null) throw new Error("title input not rendered");
    titleInput.value = "New Title";
    titleInput.dispatchEvent(new Event("change", { bubbles: true }));

    expect(opQueue.enqueued).toEqual([
      {
        file: "about",
        path: "meta.title",
        value: "New Title",
      },
    ]);
  });

  it("the close button calls onClose", () => {
    const onClose = vi.fn();
    const drawer = mountPageSettingsDrawer("about", { api: fakeApi(), opQueue: fakeQueue(), onClose });
    drawer.element.querySelector<HTMLButtonElement>(".wx-drawer-close")?.click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows an error message if content fails to load", async () => {
    const api = fakeApi({ getContent: vi.fn().mockRejectedValue(new Error("boom")) });
    const drawer = mountPageSettingsDrawer("about", { api, opQueue: fakeQueue(), onClose: vi.fn() });

    await (api.getContent as ReturnType<typeof vi.fn>).mock.results[0]?.value.catch(() => undefined);
    await Promise.resolve();

    expect(drawer.element.querySelector(".wx-drawer-body")?.textContent).toMatch(/couldn't load/i);
  });

  it("Choose image opens the shared media dialog; picking commits ogImage and updates the preview", async () => {
    const item: MediaItem = {
      name: "hero.jpg",
      url: "/images/hero.jpg",
      source: "repo",
      sizeBytes: 1024,
      width: 800,
      height: 600,
      references: [],
    };
    const api = fakeApi({ getMedia: vi.fn(async (): Promise<MediaItem[]> => [item]) });
    const opQueue = fakeQueue();
    const drawer = mountPageSettingsDrawer("about", { api, opQueue, onClose: vi.fn() });
    await (api.getContent as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    await Promise.resolve();

    const chooseButton = Array.from(drawer.element.querySelectorAll("button")).find(
      (button) => button.textContent === "Choose image",
    );
    chooseButton?.click();
    await Promise.resolve();
    await Promise.resolve();

    const dialog = document.querySelector(".wx-media-dialog-backdrop");
    expect(dialog).not.toBeNull();
    const thumb = dialog?.querySelector<HTMLButtonElement>(".wx-media-thumb");
    thumb?.click();

    const confirmButton = Array.from(dialog?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Use this image",
    );
    confirmButton?.click();

    expect(opQueue.enqueued).toEqual([
      { file: "about", path: "meta.ogImage", value: { src: "/images/hero.jpg", alt: "Hero" } },
    ]);
    expect(drawer.element.querySelector(".wx-og-image-preview img")).not.toBeNull();
    expect(document.querySelector(".wx-media-dialog-backdrop")).toBeNull();
  });

  it("teardown before content resolves prevents the late render", async () => {
    const deferred: { resolve: (value: ContentResponse) => void } = {
      resolve: () => {
        throw new Error("resolve not yet assigned");
      },
    };
    const contentPromise = new Promise<ContentResponse>((resolve) => {
      deferred.resolve = resolve;
    });
    const api = fakeApi({ getContent: vi.fn(() => contentPromise) });
    const drawer = mountPageSettingsDrawer("about", { api, opQueue: fakeQueue(), onClose: vi.fn() });
    drawer.teardown();
    deferred.resolve({
      content: { meta: { title: "About" } },
      bindings: { page: "about", fields: [] },
    });
    await contentPromise;
    await Promise.resolve();

    expect(drawer.element.querySelector(".wx-drawer-body")?.textContent).toBe("Loading…");
  });
});
