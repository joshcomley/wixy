import { describe, expect, it, vi } from "vitest";
import type { AdminApi, AdminSection, ContentResponse, MediaItem } from "../src/api";
import type { AlignerRequest, AlignerResult } from "../src/alignerDialog";
import type { OpQueueLike } from "../src/editView";
import type { DraftOp } from "../src/protocol";
import { mountSectionPanel } from "../src/sectionPanel";

const SLIDER_SECTION: AdminSection = {
  id: "before-after",
  navLabel: "Before & After",
  title: "Before & After",
  description: "Drag to reorder.",
  page: "gallery",
  collections: [
    {
      path: "gallery.sliders",
      label: "Drag-to-compare photos",
      itemNoun: "photo pair",
      schema: "gallery-slider",
      alignAspect: { w: 640, h: 360 },
      fields: [
        { key: "before", kind: "image", label: "Before photo", options: [] },
        { key: "after", kind: "image", label: "After photo", options: [] },
        { key: "title", kind: "text", label: "Treatment name", options: [] },
        { key: "sub", kind: "text", label: "Treatment type", options: [] },
        {
          key: "cat",
          kind: "choice",
          label: "Category",
          options: [
            { value: "lips", label: "Lips" },
            { value: "cheeks", label: "Cheeks" },
          ],
        },
      ],
    },
  ],
};

const TILE_SECTION: AdminSection = {
  id: "before-after",
  navLabel: "Before & After",
  title: "Before & After",
  description: "Drag to reorder.",
  page: "gallery",
  collections: [
    {
      path: "gallery.tiles",
      label: "Tap-to-zoom photos",
      itemNoun: "photo",
      schema: "gallery-tile",
      alignAspect: null,
      fields: [
        { key: "img", kind: "image", label: "Photo", options: [] },
        { key: "title", kind: "text", label: "Caption", options: [] },
        {
          key: "cat",
          kind: "choice",
          label: "Category",
          options: [{ value: "lips", label: "Lips" }],
        },
      ],
    },
  ],
};

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    getState: vi.fn(),
    getContent: vi.fn(async (): Promise<ContentResponse> => ({ content: {}, bindings: { page: "gallery", fields: [] } })),
    patchDraft: vi.fn(),
    discardDraft: vi.fn(),
    getMedia: vi.fn(async (): Promise<MediaItem[]> => []),
    uploadMedia: vi.fn(),
    deleteMedia: vi.fn(),
    ...overrides,
  } as AdminApi;
}

function fakeQueue(): OpQueueLike & { enqueued: unknown[]; flushes: number } {
  const enqueued: unknown[] = [];
  const queue = {
    rev: 0,
    enqueued,
    flushes: 0,
    enqueue: (op: DraftOp) => enqueued.push(op),
    flushNow: async (): Promise<void> => {
      queue.flushes += 1;
    },
  };
  return queue;
}

function fakeWindow(opts: { confirmReturns?: boolean } = {}): Window {
  const target = new EventTarget();
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    confirm: () => opts.confirmReturns ?? true,
  } as unknown as Window;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const SLIDER_ITEM = {
  before: { src: "images/b1.jpg", alt: "Before" },
  after: { src: "images/a1.jpg", alt: "After" },
  title: "Filler",
  sub: "Lip filler",
  cat: "lips",
};

describe("mountSectionPanel", () => {
  it("shows Loading… before content resolves, then renders the collection", async () => {
    const api = fakeApi();
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue: fakeQueue() });
    expect(panel.element.textContent).toContain("Loading…");

    await flush();

    expect(panel.element.querySelector(".wx-section-collection")).not.toBeNull();
    expect(panel.element.querySelector(".wx-section-title")?.textContent).toBe("Before & After");
  });

  it("shows the empty state when the collection's array is missing entirely", async () => {
    const api = fakeApi();
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue: fakeQueue() });
    await flush();

    expect(panel.element.querySelector(".wx-section-empty")?.textContent).toBe(
      "No photo pairs yet — add your first photo pair.",
    );
  });

  it("renders one card per item in the collection's array", async () => {
    const api = fakeApi({
      getContent: vi.fn(async () => ({
        content: { gallery: { sliders: [SLIDER_ITEM, SLIDER_ITEM] } },
        bindings: { page: "gallery", fields: [] },
      })),
    });
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue: fakeQueue() });
    await flush();

    expect(panel.element.querySelectorAll(".wx-section-card")).toHaveLength(2);
  });

  it("renders a card's picked-image thumbnails as loadable admin-origin URLs, not the raw content-form src", async () => {
    // A real bug, live-reported: `img.src = picked.src` used the CONTENT-JSON
    // form verbatim (`images/b1.jpg`, decisions/00095 — what builder/validate.py
    // expects a repo image's src to look like), which resolves against
    // whatever admin route happens to be current (e.g. `/admin/section/
    // gallery/images/b1.jpg` — 404) instead of the site root, exactly the
    // failure mode `mediaDialog.ts:contentSrcToDisplayUrl`'s own docstring
    // warns about. Every existing card-rendering test asserted card COUNT or
    // op-queue behavior, never a thumbnail's actual `src` attribute — this is
    // the coverage gap that let it ship. Draft-media form (already an
    // absolute path) must pass through unchanged; repo form must gain a
    // leading slash.
    const api = fakeApi({
      getContent: vi.fn(async () => ({
        content: {
          gallery: {
            sliders: [
              {
                ...SLIDER_ITEM,
                before: { src: "images/b1.jpg", alt: "Before" },
                after: { src: "/admin/draft-media/staged-a1.jpg", alt: "After" },
              },
            ],
          },
        },
        bindings: { page: "gallery", fields: [] },
      })),
    });
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue: fakeQueue() });
    await flush();

    const thumbs = panel.element.querySelectorAll<HTMLImageElement>(".wx-section-image-thumb");
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]?.getAttribute("src")).toBe("/images/b1.jpg");
    expect(thumbs[1]?.getAttribute("src")).toBe("/admin/draft-media/staged-a1.jpg");
  });

  it("editing a text field commits the whole array on blur", async () => {
    const api = fakeApi({
      getContent: vi.fn(async () => ({
        content: { gallery: { sliders: [SLIDER_ITEM] } },
        bindings: { page: "gallery", fields: [] },
      })),
    });
    const opQueue = fakeQueue();
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue });
    await flush();

    const titleInput = panel.element.querySelector<HTMLInputElement>(".wx-section-field-input");
    expect(titleInput).not.toBeNull();
    if (titleInput === null) throw new Error("no title input");
    titleInput.value = "Renamed";
    titleInput.dispatchEvent(new Event("blur"));

    expect(opQueue.enqueued).toEqual([
      { file: "gallery", path: "gallery.sliders", value: [{ ...SLIDER_ITEM, title: "Renamed" }] },
    ]);
  });

  it("blurring a text field with an unchanged value does not enqueue anything", async () => {
    const api = fakeApi({
      getContent: vi.fn(async () => ({
        content: { gallery: { sliders: [SLIDER_ITEM] } },
        bindings: { page: "gallery", fields: [] },
      })),
    });
    const opQueue = fakeQueue();
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue });
    await flush();

    const titleInput = panel.element.querySelector<HTMLInputElement>(".wx-section-field-input");
    titleInput?.dispatchEvent(new Event("blur"));

    expect(opQueue.enqueued).toEqual([]);
  });

  it("changing a choice field commits the whole array immediately", async () => {
    const api = fakeApi({
      getContent: vi.fn(async () => ({
        content: { gallery: { sliders: [SLIDER_ITEM] } },
        bindings: { page: "gallery", fields: [] },
      })),
    });
    const opQueue = fakeQueue();
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue });
    await flush();

    const select = panel.element.querySelector<HTMLSelectElement>(".wx-section-field-select");
    expect(select).not.toBeNull();
    if (select === null) throw new Error("no select");
    select.value = "cheeks";
    select.dispatchEvent(new Event("change"));

    expect(opQueue.enqueued).toEqual([
      { file: "gallery", path: "gallery.sliders", value: [{ ...SLIDER_ITEM, cat: "cheeks" }] },
    ]);
  });

  it("the up/down buttons commit the reordered whole array, disabled at the boundaries", async () => {
    const second = { ...SLIDER_ITEM, title: "Second" };
    const api = fakeApi({
      getContent: vi.fn(async () => ({
        content: { gallery: { sliders: [SLIDER_ITEM, second] } },
        bindings: { page: "gallery", fields: [] },
      })),
    });
    const opQueue = fakeQueue();
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue });
    await flush();

    const cards = panel.element.querySelectorAll(".wx-section-card");
    const firstUp = cards[0]?.querySelector<HTMLButtonElement>('[aria-label="Move up"]');
    const firstDown = cards[0]?.querySelector<HTMLButtonElement>('[aria-label="Move down"]');
    const lastDown = cards[1]?.querySelector<HTMLButtonElement>('[aria-label="Move down"]');
    expect(firstUp?.disabled).toBe(true);
    expect(lastDown?.disabled).toBe(true);

    firstDown?.click();

    expect(opQueue.enqueued).toEqual([
      { file: "gallery", path: "gallery.sliders", value: [second, SLIDER_ITEM] },
    ]);
  });

  it("Remove asks for confirmation and only commits the array without that item when confirmed", async () => {
    const api = fakeApi({
      getContent: vi.fn(async () => ({
        content: { gallery: { sliders: [SLIDER_ITEM] } },
        bindings: { page: "gallery", fields: [] },
      })),
    });
    const opQueue = fakeQueue();
    const declineWin = fakeWindow({ confirmReturns: false });
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue, win: declineWin });
    await flush();

    panel.element.querySelector<HTMLButtonElement>(".wx-section-delete-button")?.click();
    expect(opQueue.enqueued).toEqual([]);
  });

  it("Remove commits the array without that item once confirmed", async () => {
    const api = fakeApi({
      getContent: vi.fn(async () => ({
        content: { gallery: { sliders: [SLIDER_ITEM] } },
        bindings: { page: "gallery", fields: [] },
      })),
    });
    const opQueue = fakeQueue();
    const confirmWin = fakeWindow({ confirmReturns: true });
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue, win: confirmWin });
    await flush();

    panel.element.querySelector<HTMLButtonElement>(".wx-section-delete-button")?.click();
    expect(opQueue.enqueued).toEqual([{ file: "gallery", path: "gallery.sliders", value: [] }]);
  });

  it("the guided add flow gates Save until the photo and title are both filled, then appends the item", async () => {
    const pickedItem: MediaItem = {
      name: "cheek.jpg",
      url: "/images/cheek.jpg",
      contentSrc: "images/cheek.jpg",
      source: "repo",
      sizeBytes: 1024,
      width: 800,
      height: 600,
      references: [],
    };
    const api = fakeApi({
      getContent: vi.fn(async () => ({
        content: {},
        bindings: { page: "gallery", fields: [] },
      })),
      getMedia: vi.fn(async () => [pickedItem]),
    });
    const opQueue = fakeQueue();
    const panel = mountSectionPanel(TILE_SECTION, { api, opQueue, win: fakeWindow() });
    await flush();

    panel.element
      .querySelector<HTMLButtonElement>(".wx-section-add-button")
      ?.click();
    const dialog = panel.element.querySelector(".wx-section-add-dialog");
    expect(dialog).not.toBeNull();

    const findButton = (text: string): HTMLButtonElement | undefined =>
      Array.from(dialog?.querySelectorAll("button") ?? []).find((b) => b.textContent === text);

    // Step 1: no photo yet -> Next is disabled.
    expect(findButton("Next")?.disabled).toBe(true);

    findButton("Choose Photo")?.click();
    await flush();
    const mediaDialog = document.querySelector(".wx-media-dialog-backdrop");
    expect(mediaDialog).not.toBeNull();
    mediaDialog?.querySelector<HTMLButtonElement>(".wx-media-thumb")?.click();
    const useThisImage = Array.from(mediaDialog?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Use this image",
    );
    useThisImage?.click();

    // Photo picked -> the step re-renders with a preview. Same live bug as the
    // card thumbnail's own regression test above: this must be a loadable
    // admin-origin URL (`/images/cheek.jpg`), never the raw content-form src
    // (`images/cheek.jpg`) `onPick` stores.
    const preview = dialog?.querySelector<HTMLImageElement>(".wx-section-add-preview");
    expect(preview?.getAttribute("src")).toBe("/images/cheek.jpg");

    // Photo picked -> Next now enabled; advance to the form step.
    expect(findButton("Next")?.disabled).toBe(false);
    findButton("Next")?.click();

    // Form step: Save disabled until the title is filled.
    expect(findButton("Save")?.disabled).toBe(true);
    const titleInput = dialog?.querySelector<HTMLInputElement>("input[type='text']");
    expect(titleInput).not.toBeNull();
    if (titleInput === null || titleInput === undefined) throw new Error("no title input");
    titleInput.value = "Cheek filler";
    titleInput.dispatchEvent(new Event("input"));
    expect(findButton("Save")?.disabled).toBe(false);

    findButton("Save")?.click();

    expect(opQueue.enqueued).toEqual([
      {
        file: "gallery",
        path: "gallery.tiles",
        value: [
          {
            img: { src: "images/cheek.jpg", alt: "Cheek" },
            title: "Cheek filler",
            cat: "lips",
          },
        ],
      },
    ]);
    expect(panel.element.querySelector(".wx-section-add-dialog")).toBeNull();
  });
});

describe("mountSectionPanel — the before/after aligner (decisions/00111)", () => {
  function slidersApi(item: typeof SLIDER_ITEM = SLIDER_ITEM): AdminApi {
    return fakeApi({
      getContent: vi.fn(async () => ({
        content: { gallery: { sliders: [item] } },
        bindings: { page: "gallery", fields: [] },
      })),
    });
  }

  /** A stub for the canvas dialog (jsdom has no canvas): captures the request
   * and hands the test the `respond` callback to drive directly. */
  function stubAligner() {
    const calls: AlignerRequest[] = [];
    let respond: ((result: AlignerResult | null) => void) | null = null;
    const stub = (_deps: unknown, request: AlignerRequest, cb: (r: AlignerResult | null) => void): void => {
      calls.push(request);
      respond = cb;
    };
    return { calls, fire: (r: AlignerResult | null) => respond?.(r), stub };
  }

  it("a fully-picked pair card gets a Line up photos button", async () => {
    const panel = mountSectionPanel(SLIDER_SECTION, { api: slidersApi(), opQueue: fakeQueue() });
    await flush();
    const button = panel.element.querySelector(".wx-section-align-button");
    expect(button?.textContent).toBe("Line up photos");
  });

  it("no alignAspect (or only one image field) means no button", async () => {
    const api = fakeApi({
      getContent: vi.fn(async () => ({
        content: {
          gallery: { tiles: [{ img: { src: "images/t1.jpg", alt: "t" }, title: "T", cat: "lips" }] },
        },
        bindings: { page: "gallery", fields: [] },
      })),
    });
    const panel = mountSectionPanel(TILE_SECTION, { api, opQueue: fakeQueue() });
    await flush();
    expect(panel.element.querySelector(".wx-section-align-button")).toBeNull();
  });

  it("a pair with a photo still missing gets no button (nothing to line up against)", async () => {
    const halfPicked = { ...SLIDER_ITEM, after: { src: "", alt: "" } };
    const panel = mountSectionPanel(SLIDER_SECTION, { api: slidersApi(halfPicked), opQueue: fakeQueue() });
    await flush();
    expect(panel.element.querySelector(".wx-section-align-button")).toBeNull();
  });

  it("clicking opens the aligner with the pair's photos + the registry frame aspect", async () => {
    const { calls, stub } = stubAligner();
    const panel = mountSectionPanel(SLIDER_SECTION, {
      api: slidersApi(),
      opQueue: fakeQueue(),
      openAligner: stub,
    });
    await flush();
    panel.element.querySelector<HTMLButtonElement>(".wx-section-align-button")?.click();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      first: { key: "before", label: "Before photo", src: "images/b1.jpg", alt: "Before" },
      second: { key: "after", label: "After photo", src: "images/a1.jpg", alt: "After" },
      aspectW: 640,
      aspectH: 360,
    });
  });

  it("a saved alignment commits the whole array with the baked photo(s) swapped in, alt preserved", async () => {
    const opQueue = fakeQueue();
    const { fire, stub } = stubAligner();
    const panel = mountSectionPanel(SLIDER_SECTION, {
      api: slidersApi(),
      opQueue,
      openAligner: stub,
    });
    await flush();
    panel.element.querySelector<HTMLButtonElement>(".wx-section-align-button")?.click();
    fire({ second: { src: "images/eee555ff-lips-after-aligned.jpg", alt: "After" } });

    expect(opQueue.enqueued).toEqual([
      {
        file: "gallery",
        path: "gallery.sliders",
        value: [{ ...SLIDER_ITEM, after: { src: "images/eee555ff-lips-after-aligned.jpg", alt: "After" } }],
      },
    ]);
  });

  it("a cancelled aligner commits nothing", async () => {
    const opQueue = fakeQueue();
    const { fire, stub } = stubAligner();
    const panel = mountSectionPanel(SLIDER_SECTION, {
      api: slidersApi(),
      opQueue,
      openAligner: stub,
    });
    await flush();
    panel.element.querySelector<HTMLButtonElement>(".wx-section-align-button")?.click();
    fire(null);
    expect(opQueue.enqueued).toEqual([]);
  });

  it("the add flow offers the aligner on its form step, and the result becomes the new item's photo", async () => {
    const beforeItem: MediaItem = {
      name: "b1.jpg",
      url: "/images/b1.jpg",
      contentSrc: "images/b1.jpg",
      source: "repo",
      sizeBytes: 1024,
      width: 800,
      height: 600,
      references: [],
    };
    const afterItem: MediaItem = { ...beforeItem, name: "a1.jpg", url: "/images/a1.jpg", contentSrc: "images/a1.jpg" };
    const api = fakeApi({
      getContent: vi.fn(async () => ({ content: {}, bindings: { page: "gallery", fields: [] } })),
      getMedia: vi.fn(async () => [beforeItem, afterItem]),
    });
    const opQueue = fakeQueue();
    const { fire, stub } = stubAligner();
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue, win: fakeWindow(), openAligner: stub });
    await flush();

    panel.element.querySelector<HTMLButtonElement>(".wx-section-add-button")?.click();
    const dialog = panel.element.querySelector(".wx-section-add-dialog");
    const findButton = (text: string): HTMLButtonElement | undefined =>
      Array.from(dialog?.querySelectorAll("button") ?? []).find((b) => b.textContent === text);
    const pickFromMediaDialog = async (name: string): Promise<void> => {
      const mediaDialog = document.querySelector(".wx-media-dialog-backdrop");
      const thumb = Array.from(mediaDialog?.querySelectorAll<HTMLButtonElement>(".wx-media-thumb") ?? []).find(
        (t) => t.querySelector("img")?.getAttribute("src") === `/images/${name}`,
      );
      thumb?.click();
      await flush();
      Array.from(mediaDialog?.querySelectorAll("button") ?? [])
        .find((b) => b.textContent === "Use this image")
        ?.click();
      await flush();
    };

    findButton("Choose Before photo")?.click();
    await flush();
    await pickFromMediaDialog("b1.jpg");
    findButton("Next")?.click();
    findButton("Choose After photo")?.click();
    await flush();
    await pickFromMediaDialog("a1.jpg");
    findButton("Next")?.click();

    // Form step: the aligner button is there; using it swaps the draft's after
    // photo (the real aligner echoes the side's original alt — "A1" here from
    // the media pick's filename guess — which the stored item must keep).
    findButton("Line up photos")?.click();
    fire({ second: { src: "images/fff666aa-a1-aligned.jpg", alt: "A1" } });

    const titleInput = dialog?.querySelector<HTMLInputElement>("input[type='text']");
    if (titleInput === null || titleInput === undefined) throw new Error("no title input");
    titleInput.value = "Lip filler";
    titleInput.dispatchEvent(new Event("input"));
    findButton("Save")?.click();

    expect(opQueue.enqueued).toEqual([
      {
        file: "gallery",
        path: "gallery.sliders",
        value: [
          {
            before: { src: "images/b1.jpg", alt: "B1" },
            after: { src: "images/fff666aa-a1-aligned.jpg", alt: "A1" },
            title: "Lip filler",
            sub: "",
            cat: "lips",
          },
        ],
      },
    ]);
  });

  describe("refresh (decisions/00115)", () => {
    /** The publish-time shape: the panel loaded while the pair was a staged
     * upload; the publish then re-pointed it at `images/<name>` and deleted the
     * staged file. Whatever the panel writes NEXT has to carry the new src. */
    function apiWithStagedThenPublished(): AdminApi {
      let src = "/admin/draft-media/abc12345-a1.jpg";
      const api = fakeApi({
        getContent: vi.fn(async (): Promise<ContentResponse> => ({
          content: { gallery: { sliders: [{ ...SLIDER_ITEM, after: { src, alt: "After" } }] } },
          bindings: { page: "gallery", fields: [] },
        })),
      });
      return Object.assign(api, {
        publish: (): void => {
          src = "images/abc12345-a1.jpg";
        },
      });
    }

    it("re-reads the collection so the next edit carries the published src, not the dead staged one", async () => {
      const api = apiWithStagedThenPublished();
      const opQueue = fakeQueue();
      const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue });
      await flush();

      (api as unknown as { publish: () => void }).publish();
      panel.refresh();
      await flush();
      await flush();

      const titleInput = panel.element.querySelector<HTMLInputElement>(".wx-section-field-input")!;
      titleInput.value = "Retitled";
      titleInput.dispatchEvent(new Event("blur"));

      expect(opQueue.enqueued).toEqual([
        {
          file: "gallery",
          path: "gallery.sliders",
          value: [
            {
              ...SLIDER_ITEM,
              after: { src: "images/abc12345-a1.jpg", alt: "After" },
              title: "Retitled",
            },
          ],
        },
      ]);
    });

    it("flushes queued ops before re-reading, so a just-typed value isn't read back stale", async () => {
      const api = apiWithStagedThenPublished();
      const opQueue = fakeQueue();
      const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue });
      await flush();

      panel.refresh();
      await flush();

      expect(opQueue.flushes).toBe(1);
    });

    it("defers the re-read while a field has focus, so it never eats what she is typing", async () => {
      const api = apiWithStagedThenPublished();
      const opQueue = fakeQueue();
      const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue });
      await flush();
      document.body.appendChild(panel.element);
      try {
        const titleInput = panel.element.querySelector<HTMLInputElement>(".wx-section-field-input")!;
        titleInput.focus();
        const readsBefore = (api.getContent as ReturnType<typeof vi.fn>).mock.calls.length;

        panel.refresh();
        await flush();

        expect((api.getContent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(readsBefore);
        expect(opQueue.flushes).toBe(0);

        titleInput.blur(); // focusout — the deferred re-read runs now
        await new Promise((resolve) => setTimeout(resolve, 0));
        await flush();

        expect((api.getContent as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
          readsBefore,
        );
      } finally {
        panel.element.remove();
      }
    });
  });
});
