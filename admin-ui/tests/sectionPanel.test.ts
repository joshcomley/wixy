import { describe, expect, it, vi } from "vitest";
import type { AdminApi, AdminSection, ContentResponse, MediaItem, StateResponse } from "../src/api";
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
        { key: "visible", kind: "toggle", label: "Show on site", options: [] },
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
        { key: "visible", kind: "toggle", label: "Show on site", options: [] },
      ],
    },
  ],
};

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    getState: vi.fn(async () => ({ draft: { rev: 0, opCount: 0 } }) as StateResponse),
    getContent: vi.fn(async (): Promise<ContentResponse> => ({ content: {}, bindings: { page: "gallery", fields: [] } })),
    patchDraft: vi.fn(),
    discardDraft: vi.fn(async () => ({ rev: 1 })),
    getMedia: vi.fn(async (): Promise<MediaItem[]> => []),
    uploadMedia: vi.fn(),
    deleteMedia: vi.fn(),
    ...overrides,
  } as AdminApi;
}

/** A faithful-enough fake of `OpQueue` (opQueue.ts) for the staged-save model
 * (decisions/00118): `enqueue` only stages into `pending`; `flushNow` is what
 * moves `pending` into `enqueued` (the assertion surface every existing test
 * uses) AND advances `rev` — exactly the "rev advanced = the batch landed"
 * signal `sectionPanel.ts`'s `saveNow` reads, since `OpQueueLike` exposes no
 * richer success/failure signal. Setting `failFlushes` simulates BOTH a real
 * failure mode (a network error that re-queues the batch, or a 422 that drops
 * it) — both leave `rev` untouched, which is the only distinction the panel
 * can observe. */
function fakeQueue(): OpQueueLike & { enqueued: unknown[]; flushes: number; failFlushes: boolean } {
  const enqueued: unknown[] = [];
  let pending: DraftOp[] = [];
  const queue = {
    rev: 0,
    enqueued,
    flushes: 0,
    failFlushes: false,
    enqueue: (op: DraftOp) => pending.push(op),
    flushNow: async (): Promise<void> => {
      queue.flushes += 1;
      if (queue.failFlushes || pending.length === 0) return;
      enqueued.push(...pending);
      pending = [];
      queue.rev += 1;
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
  // 4 ticks (`load()`'s `Promise.all([getContent, refreshDraftState])` adds a
  // hop over the pre-decisions/00118 2-tick margin) — cheap to over-provision;
  // an already-settled promise's `await` just continues immediately.
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** Clicks the panel-level Save bar's Save button (decisions/00118) — distinct
 * from the guided add-flow's OWN "Save" button, which only finishes the
 * wizard and stages the new item locally; this is what actually writes the
 * whole array to the draft via `opQueue`. */
function clickSave(panel: { element: HTMLElement }): void {
  const button = panel.element.querySelector<HTMLButtonElement>(".wx-section-save-button");
  if (button === null) throw new Error("no Save button");
  button.click();
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

  it("editing a text field stages it locally on blur (no enqueue) — Save then writes the whole array", async () => {
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

    // Staged, not yet written — the whole point of decisions/00118's model.
    // Staging re-renders the card (so the new value/dirty state paints), so
    // re-query rather than reuse the pre-blur node the rebuild discarded.
    expect(opQueue.enqueued).toEqual([]);
    const titleInputAfterStage = panel.element.querySelector<HTMLInputElement>(".wx-section-field-input");
    expect(titleInputAfterStage?.classList.contains("wx-field-dirty")).toBe(true);
    const saveButton = panel.element.querySelector<HTMLButtonElement>(".wx-section-save-button");
    expect(saveButton?.disabled).toBe(false);
    expect(panel.element.querySelector(".wx-section-save-bar")?.hasAttribute("hidden")).toBe(false);

    clickSave(panel);
    await flush();

    expect(opQueue.enqueued).toEqual([
      { file: "gallery", path: "gallery.sliders", value: [{ ...SLIDER_ITEM, title: "Renamed" }] },
    ]);
    // A successful Save re-renders the card (so the dirty marker clears) —
    // re-query rather than reuse the pre-Save node, which the rebuild discards.
    const titleInputAfterSave = panel.element.querySelector<HTMLInputElement>(".wx-section-field-input");
    expect(titleInputAfterSave?.classList.contains("wx-field-dirty")).toBe(false);
    expect(saveButton?.disabled).toBe(true);
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
    expect(panel.element.querySelector(".wx-section-save-bar")?.hasAttribute("hidden")).toBe(true);
    expect(panel.hasUnsavedChanges()).toBe(false);
  });

  it("changing a choice field stages it locally, then Save writes the whole array", async () => {
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

    expect(opQueue.enqueued).toEqual([]);
    clickSave(panel);
    await flush();

    expect(opQueue.enqueued).toEqual([
      { file: "gallery", path: "gallery.sliders", value: [{ ...SLIDER_ITEM, cat: "cheeks" }] },
    ]);
  });

  it("the up/down buttons stage the reordered whole array, disabled at the boundaries", async () => {
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

    expect(opQueue.enqueued).toEqual([]);
    expect(panel.hasUnsavedChanges()).toBe(true);
    clickSave(panel);
    await flush();

    expect(opQueue.enqueued).toEqual([
      { file: "gallery", path: "gallery.sliders", value: [second, SLIDER_ITEM] },
    ]);
  });

  it("Remove asks for confirmation and leaves everything untouched when declined", async () => {
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
    expect(panel.element.querySelectorAll(".wx-section-card")).toHaveLength(1);
    expect(panel.hasUnsavedChanges()).toBe(false);
    expect(opQueue.enqueued).toEqual([]);
  });

  it("Remove stages the array without that item once confirmed; Save then writes it", async () => {
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
    expect(panel.element.querySelectorAll(".wx-section-card")).toHaveLength(0);
    expect(opQueue.enqueued).toEqual([]);

    clickSave(panel);
    await flush();

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

    // The wizard's own Save only finishes the ITEM and stages it locally
    // (decisions/00118) — it doesn't reach the draft until the panel-level
    // Save bar is pressed, same as any other edit in this panel.
    expect(panel.element.querySelector(".wx-section-add-dialog")).toBeNull();
    expect(opQueue.enqueued).toEqual([]);
    expect(panel.hasUnsavedChanges()).toBe(true);

    clickSave(panel);
    await flush();

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
  });
});

describe("mountSectionPanel — the visible toggle (Show on site)", () => {
  it("a shown item's toggle is checked by default and the card carries no hidden styling", async () => {
    const api = fakeApi({
      getContent: vi.fn(async () => ({
        content: { gallery: { sliders: [SLIDER_ITEM] } },
        bindings: { page: "gallery", fields: [] },
      })),
    });
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue: fakeQueue() });
    await flush();

    const toggle = panel.element.querySelector<HTMLInputElement>(".wx-section-toggle-input");
    expect(toggle?.checked).toBe(true);
    expect(panel.element.querySelector(".wx-section-card-hidden")).toBeNull();
    expect(panel.element.querySelector(".wx-section-hidden-chip")).toBeNull();
  });

  it("an item with visible:false renders unchecked, dimmed, with a Hidden chip", async () => {
    const api = fakeApi({
      getContent: vi.fn(async () => ({
        content: { gallery: { sliders: [{ ...SLIDER_ITEM, visible: false }] } },
        bindings: { page: "gallery", fields: [] },
      })),
    });
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue: fakeQueue() });
    await flush();

    const toggle = panel.element.querySelector<HTMLInputElement>(".wx-section-toggle-input");
    expect(toggle?.checked).toBe(false);
    expect(panel.element.querySelector(".wx-section-card-hidden")).not.toBeNull();
    expect(panel.element.querySelector(".wx-section-hidden-chip")?.textContent).toBe("Hidden");
  });

  it("unchecking the toggle stages visible:false on exactly that item; Save then writes it", async () => {
    const api = fakeApi({
      getContent: vi.fn(async () => ({
        content: { gallery: { sliders: [SLIDER_ITEM] } },
        bindings: { page: "gallery", fields: [] },
      })),
    });
    const opQueue = fakeQueue();
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue });
    await flush();

    const toggle = panel.element.querySelector<HTMLInputElement>(".wx-section-toggle-input");
    expect(toggle).not.toBeNull();
    if (toggle === null) throw new Error("no toggle input");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));

    expect(opQueue.enqueued).toEqual([]);
    clickSave(panel);
    await flush();

    expect(opQueue.enqueued).toEqual([
      { file: "gallery", path: "gallery.sliders", value: [{ ...SLIDER_ITEM, visible: false }] },
    ]);
  });

  it("re-checking an already-hidden item stages the array with the key REMOVED, not set true", async () => {
    const api = fakeApi({
      getContent: vi.fn(async () => ({
        content: { gallery: { sliders: [{ ...SLIDER_ITEM, visible: false }] } },
        bindings: { page: "gallery", fields: [] },
      })),
    });
    const opQueue = fakeQueue();
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue });
    await flush();

    const toggle = panel.element.querySelector<HTMLInputElement>(".wx-section-toggle-input");
    expect(toggle).not.toBeNull();
    if (toggle === null) throw new Error("no toggle input");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    clickSave(panel);
    await flush();

    expect(opQueue.enqueued).toEqual([
      { file: "gallery", path: "gallery.sliders", value: [SLIDER_ITEM] },
    ]);
    const [op] = opQueue.enqueued as Array<{ value: Array<Record<string, unknown>> }>;
    expect(op !== undefined && "visible" in (op.value[0] ?? {})).toBe(false);
  });

  it("the guided add flow's new item defaults to shown (toggle checked, no key written)", async () => {
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
      getContent: vi.fn(async () => ({ content: {}, bindings: { page: "gallery", fields: [] } })),
      getMedia: vi.fn(async () => [pickedItem]),
    });
    const opQueue = fakeQueue();
    const panel = mountSectionPanel(TILE_SECTION, { api, opQueue, win: fakeWindow() });
    await flush();

    panel.element.querySelector<HTMLButtonElement>(".wx-section-add-button")?.click();
    const dialog = panel.element.querySelector(".wx-section-add-dialog");
    const findButton = (text: string): HTMLButtonElement | undefined =>
      Array.from(dialog?.querySelectorAll("button") ?? []).find((b) => b.textContent === text);

    findButton("Choose Photo")?.click();
    await flush();
    const mediaDialog = document.querySelector(".wx-media-dialog-backdrop");
    mediaDialog?.querySelector<HTMLButtonElement>(".wx-media-thumb")?.click();
    Array.from(mediaDialog?.querySelectorAll("button") ?? [])
      .find((b) => b.textContent === "Use this image")
      ?.click();
    findButton("Next")?.click();

    // Form step: the toggle is present and checked by default.
    const toggle = dialog?.querySelector<HTMLInputElement>(".wx-section-toggle-input");
    expect(toggle?.checked).toBe(true);

    const titleInput = dialog?.querySelector<HTMLInputElement>("input[type='text']");
    if (titleInput === null || titleInput === undefined) throw new Error("no title input");
    titleInput.value = "Cheek filler";
    titleInput.dispatchEvent(new Event("input"));
    findButton("Save")?.click();
    clickSave(panel);
    await flush();

    const [op] = opQueue.enqueued as Array<{ value: Array<Record<string, unknown>> }>;
    if (op === undefined) throw new Error("no op enqueued");
    expect("visible" in (op.value[0] ?? {})).toBe(false);
  });

  it("unchecking the toggle in the add flow before Save writes visible:false on the new item", async () => {
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
      getContent: vi.fn(async () => ({ content: {}, bindings: { page: "gallery", fields: [] } })),
      getMedia: vi.fn(async () => [pickedItem]),
    });
    const opQueue = fakeQueue();
    const panel = mountSectionPanel(TILE_SECTION, { api, opQueue, win: fakeWindow() });
    await flush();

    panel.element.querySelector<HTMLButtonElement>(".wx-section-add-button")?.click();
    const dialog = panel.element.querySelector(".wx-section-add-dialog");
    const findButton = (text: string): HTMLButtonElement | undefined =>
      Array.from(dialog?.querySelectorAll("button") ?? []).find((b) => b.textContent === text);

    findButton("Choose Photo")?.click();
    await flush();
    const mediaDialog = document.querySelector(".wx-media-dialog-backdrop");
    mediaDialog?.querySelector<HTMLButtonElement>(".wx-media-thumb")?.click();
    Array.from(mediaDialog?.querySelectorAll("button") ?? [])
      .find((b) => b.textContent === "Use this image")
      ?.click();
    findButton("Next")?.click();

    const toggle = dialog?.querySelector<HTMLInputElement>(".wx-section-toggle-input");
    if (toggle === null || toggle === undefined) throw new Error("no toggle input");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));

    const titleInput = dialog?.querySelector<HTMLInputElement>("input[type='text']");
    if (titleInput === null || titleInput === undefined) throw new Error("no title input");
    titleInput.value = "Cheek filler";
    titleInput.dispatchEvent(new Event("input"));
    findButton("Save")?.click();
    clickSave(panel);
    await flush();

    expect(opQueue.enqueued).toEqual([
      {
        file: "gallery",
        path: "gallery.tiles",
        value: [
          {
            img: { src: "images/cheek.jpg", alt: "Cheek" },
            title: "Cheek filler",
            cat: "lips",
            visible: false,
          },
        ],
      },
    ]);
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

  it("a saved alignment stages the whole array with the baked photo(s) swapped in; Save writes it, alt preserved", async () => {
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

    expect(opQueue.enqueued).toEqual([]);
    clickSave(panel);
    await flush();

    expect(opQueue.enqueued).toEqual([
      {
        file: "gallery",
        path: "gallery.sliders",
        value: [{ ...SLIDER_ITEM, after: { src: "images/eee555ff-lips-after-aligned.jpg", alt: "After" } }],
      },
    ]);
  });

  it("a cancelled aligner stages nothing", async () => {
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
    expect(panel.hasUnsavedChanges()).toBe(false);
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
    clickSave(panel);
    await flush();

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
      clickSave(panel);
      await flush();

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

describe("mountSectionPanel — staged save, undo, discard, publish (decisions/00118)", () => {
  function sliderApi(overrides: Partial<AdminApi> = {}): AdminApi {
    return fakeApi({
      getContent: vi.fn(async () => ({
        content: { gallery: { sliders: [SLIDER_ITEM] } },
        bindings: { page: "gallery", fields: [] },
      })),
      ...overrides,
    });
  }

  it("Save is disabled with nothing to save, and the save bar stays hidden", async () => {
    const panel = mountSectionPanel(SLIDER_SECTION, { api: sliderApi(), opQueue: fakeQueue() });
    await flush();

    expect(panel.hasUnsavedChanges()).toBe(false);
    expect(panel.element.querySelector<HTMLButtonElement>(".wx-section-save-button")?.disabled).toBe(true);
    expect(panel.element.querySelector(".wx-section-save-bar")?.hasAttribute("hidden")).toBe(true);
  });

  it("Undo last reverts the most recent local edit, with nothing enqueued", async () => {
    const opQueue = fakeQueue();
    const panel = mountSectionPanel(SLIDER_SECTION, { api: sliderApi(), opQueue });
    await flush();

    const titleInput = panel.element.querySelector<HTMLInputElement>(".wx-section-field-input")!;
    titleInput.value = "Renamed";
    titleInput.dispatchEvent(new Event("blur"));
    expect(panel.hasUnsavedChanges()).toBe(true);

    const undoButton = panel.element.querySelector<HTMLButtonElement>(".wx-section-undo-button");
    expect(undoButton?.hidden).toBe(false);
    undoButton?.click();

    expect(panel.hasUnsavedChanges()).toBe(false);
    expect(opQueue.enqueued).toEqual([]);
    const titleInputAfterUndo = panel.element.querySelector<HTMLInputElement>(".wx-section-field-input");
    expect(titleInputAfterUndo?.value).toBe(SLIDER_ITEM.title);
    expect(panel.element.querySelector(".wx-section-save-bar")?.hasAttribute("hidden")).toBe(true);
  });

  it("Undo last steps back through several edits one at a time", async () => {
    const opQueue = fakeQueue();
    const panel = mountSectionPanel(SLIDER_SECTION, { api: sliderApi(), opQueue });
    await flush();

    const firstEdit = (value: string): void => {
      const input = panel.element.querySelector<HTMLInputElement>(".wx-section-field-input")!;
      input.value = value;
      input.dispatchEvent(new Event("blur"));
    };
    firstEdit("Edit one");
    firstEdit("Edit two");
    const undoButton = panel.element.querySelector<HTMLButtonElement>(".wx-section-undo-button")!;

    undoButton.click();
    expect(panel.element.querySelector<HTMLInputElement>(".wx-section-field-input")?.value).toBe(
      "Edit one",
    );
    expect(panel.hasUnsavedChanges()).toBe(true); // still one edit ahead of saved

    undoButton.click();
    expect(panel.element.querySelector<HTMLInputElement>(".wx-section-field-input")?.value).toBe(
      SLIDER_ITEM.title,
    );
    expect(panel.hasUnsavedChanges()).toBe(false);
    expect(opQueue.enqueued).toEqual([]);
  });

  it("Discard unsaved asks for confirmation, and declining leaves the edit in place", async () => {
    const opQueue = fakeQueue();
    const win = fakeWindow({ confirmReturns: false });
    const panel = mountSectionPanel(SLIDER_SECTION, { api: sliderApi(), opQueue, win });
    await flush();

    const titleInput = panel.element.querySelector<HTMLInputElement>(".wx-section-field-input")!;
    titleInput.value = "Renamed";
    titleInput.dispatchEvent(new Event("blur"));

    panel.element.querySelector<HTMLButtonElement>(".wx-section-discard-unsaved-button")?.click();

    expect(panel.hasUnsavedChanges()).toBe(true);
    expect(panel.element.querySelector<HTMLInputElement>(".wx-section-field-input")?.value).toBe(
      "Renamed",
    );
  });

  it("Discard unsaved, once confirmed, reverts every collection to the last-saved state with no enqueue", async () => {
    const opQueue = fakeQueue();
    const win = fakeWindow({ confirmReturns: true });
    const panel = mountSectionPanel(SLIDER_SECTION, { api: sliderApi(), opQueue, win });
    await flush();

    const titleInput = panel.element.querySelector<HTMLInputElement>(".wx-section-field-input")!;
    titleInput.value = "Renamed";
    titleInput.dispatchEvent(new Event("blur"));

    panel.element.querySelector<HTMLButtonElement>(".wx-section-discard-unsaved-button")?.click();

    expect(panel.hasUnsavedChanges()).toBe(false);
    expect(opQueue.enqueued).toEqual([]);
    expect(panel.element.querySelector<HTMLInputElement>(".wx-section-field-input")?.value).toBe(
      SLIDER_ITEM.title,
    );
    expect(panel.element.querySelector(".wx-section-save-bar")?.hasAttribute("hidden")).toBe(true);
  });

  it("the ready-to-publish banner reflects the draft's opCount, hidden at zero", async () => {
    const api = sliderApi({ getState: vi.fn(async () => ({ draft: { rev: 0, opCount: 0 } }) as StateResponse) });
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue: fakeQueue() });
    await flush();

    expect(panel.element.querySelector(".wx-section-ready-banner")?.hasAttribute("hidden")).toBe(true);
  });

  it("Save writes the draft, then the ready-to-publish banner updates from the new opCount", async () => {
    let opCount = 0;
    const api = sliderApi({ getState: vi.fn(async () => ({ draft: { rev: 0, opCount } }) as StateResponse) });
    const opQueue = fakeQueue();
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue });
    await flush();
    expect(panel.element.querySelector(".wx-section-ready-banner")?.hasAttribute("hidden")).toBe(true);

    opCount = 1; // what the server would report once this Save lands
    const titleInput = panel.element.querySelector<HTMLInputElement>(".wx-section-field-input")!;
    titleInput.value = "Renamed";
    titleInput.dispatchEvent(new Event("blur"));
    clickSave(panel);
    await flush();

    const banner = panel.element.querySelector(".wx-section-ready-banner");
    expect(banner?.hasAttribute("hidden")).toBe(false);
    expect(panel.element.querySelector(".wx-section-ready-banner-text")?.textContent).toBe(
      "1 change ready to publish",
    );
  });

  it("a failed Save (rev doesn't advance) keeps the panel dirty, shows an error, and Save stays enabled", async () => {
    const opQueue = fakeQueue();
    opQueue.failFlushes = true;
    const panel = mountSectionPanel(SLIDER_SECTION, { api: sliderApi(), opQueue });
    await flush();

    const titleInput = panel.element.querySelector<HTMLInputElement>(".wx-section-field-input")!;
    titleInput.value = "Renamed";
    titleInput.dispatchEvent(new Event("blur"));
    clickSave(panel);
    await flush();

    expect(panel.hasUnsavedChanges()).toBe(true);
    const saveButton = panel.element.querySelector<HTMLButtonElement>(".wx-section-save-button");
    expect(saveButton?.disabled).toBe(false);
    expect(panel.element.querySelector(".wx-section-save-bar-status")?.textContent).toMatch(
      /couldn.t save/i,
    );
    // Recovers on a later successful attempt without needing a remount.
    opQueue.failFlushes = false;
    clickSave(panel);
    await flush();
    expect(panel.hasUnsavedChanges()).toBe(false);
  });

  it("Publish auto-saves dirty edits first, then asks the shell to open the drawer", async () => {
    const api = sliderApi({ getState: vi.fn(async () => ({ draft: { rev: 0, opCount: 1 } }) as StateResponse) });
    const opQueue = fakeQueue();
    let requested = 0;
    const panel = mountSectionPanel(SLIDER_SECTION, {
      api,
      opQueue,
      onRequestPublish: () => {
        requested += 1;
      },
    });
    await flush();

    const titleInput = panel.element.querySelector<HTMLInputElement>(".wx-section-field-input")!;
    titleInput.value = "Renamed";
    titleInput.dispatchEvent(new Event("blur"));
    expect(panel.hasUnsavedChanges()).toBe(true);

    panel.element
      .querySelector<HTMLButtonElement>(".wx-section-ready-banner .wx-publish-button")
      ?.click();
    await flush();

    expect(opQueue.enqueued).toEqual([
      { file: "gallery", path: "gallery.sliders", value: [{ ...SLIDER_ITEM, title: "Renamed" }] },
    ]);
    expect(panel.hasUnsavedChanges()).toBe(false);
    expect(requested).toBe(1);
  });

  it("Publish with nothing unsaved skips the save step and asks the shell to open the drawer directly", async () => {
    const api = sliderApi({ getState: vi.fn(async () => ({ draft: { rev: 0, opCount: 1 } }) as StateResponse) });
    const opQueue = fakeQueue();
    let requested = 0;
    const panel = mountSectionPanel(SLIDER_SECTION, {
      api,
      opQueue,
      onRequestPublish: () => {
        requested += 1;
      },
    });
    await flush();

    panel.element
      .querySelector<HTMLButtonElement>(".wx-section-ready-banner .wx-publish-button")
      ?.click();
    await flush();

    expect(opQueue.flushes).toBe(0);
    expect(requested).toBe(1);
  });

  it("Publish stays put on a save failure — the shell is never asked to open the drawer", async () => {
    const api = sliderApi({ getState: vi.fn(async () => ({ draft: { rev: 0, opCount: 1 } }) as StateResponse) });
    const opQueue = fakeQueue();
    opQueue.failFlushes = true;
    let requested = 0;
    const panel = mountSectionPanel(SLIDER_SECTION, {
      api,
      opQueue,
      onRequestPublish: () => {
        requested += 1;
      },
    });
    await flush();

    const titleInput = panel.element.querySelector<HTMLInputElement>(".wx-section-field-input")!;
    titleInput.value = "Renamed";
    titleInput.dispatchEvent(new Event("blur"));

    panel.element
      .querySelector<HTMLButtonElement>(".wx-section-ready-banner .wx-publish-button")
      ?.click();
    await flush();

    expect(requested).toBe(0);
    expect(panel.hasUnsavedChanges()).toBe(true);
  });

  it("Discard all changes asks for confirmation, and declining leaves the draft untouched", async () => {
    const api = sliderApi({ getState: vi.fn(async () => ({ draft: { rev: 0, opCount: 1 } }) as StateResponse) });
    const win = fakeWindow({ confirmReturns: false });
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue: fakeQueue(), win });
    await flush();

    panel.element.querySelector<HTMLButtonElement>(".wx-section-discard-all-button")?.click();
    await flush();

    expect(api.discardDraft).not.toHaveBeenCalled();
    expect(panel.element.querySelectorAll(".wx-section-card")).toHaveLength(1);
  });

  it("Discard all changes, once confirmed, calls api.discardDraft, reloads a clean panel, and notifies the shell", async () => {
    let discarded = false;
    const api = sliderApi({
      getContent: vi.fn(async () => ({
        content: { gallery: { sliders: discarded ? [] : [SLIDER_ITEM] } },
        bindings: { page: "gallery", fields: [] },
      })),
      getState: vi.fn(async () => ({ draft: { rev: discarded ? 2 : 1, opCount: discarded ? 0 : 1 } }) as StateResponse),
      discardDraft: vi.fn(async () => {
        discarded = true;
        return { rev: 2 };
      }),
    });
    const win = fakeWindow({ confirmReturns: true });
    let draftChangedCalls = 0;
    const panel = mountSectionPanel(SLIDER_SECTION, {
      api,
      opQueue: fakeQueue(),
      win,
      onDraftChanged: () => {
        draftChangedCalls += 1;
      },
    });
    await flush();
    expect(panel.element.querySelector(".wx-section-ready-banner")?.hasAttribute("hidden")).toBe(false);

    panel.element.querySelector<HTMLButtonElement>(".wx-section-discard-all-button")?.click();
    await flush();

    expect(api.discardDraft).toHaveBeenCalledTimes(1);
    expect(draftChangedCalls).toBe(1);
    expect(panel.element.querySelectorAll(".wx-section-card")).toHaveLength(0);
    expect(panel.element.querySelector(".wx-section-ready-banner")?.hasAttribute("hidden")).toBe(true);
  });

  it("Discard all changes disables the button and ignores a second click while the network round-trip is in flight", async () => {
    let resolveDiscard: (() => void) | undefined;
    const api = sliderApi({
      getState: vi.fn(async () => ({ draft: { rev: 0, opCount: 1 } }) as StateResponse),
      discardDraft: vi.fn(
        () =>
          new Promise<{ rev: number }>((resolve) => {
            resolveDiscard = () => resolve({ rev: 1 });
          }),
      ),
    });
    const win = fakeWindow({ confirmReturns: true });
    const panel = mountSectionPanel(SLIDER_SECTION, { api, opQueue: fakeQueue(), win });
    await flush();

    const discardAllButton = panel.element.querySelector<HTMLButtonElement>(".wx-section-discard-all-button");
    discardAllButton?.click();
    await flush();
    expect(discardAllButton?.disabled).toBe(true);

    discardAllButton?.click(); // still in flight — must not fire a second confirm/discard
    await flush();
    expect(api.discardDraft).toHaveBeenCalledTimes(1);

    resolveDiscard?.();
    await flush();
    expect(discardAllButton?.disabled).toBe(false);
  });

  it("prompts before a tab close/reload while dirty, via beforeunload; not while clean", async () => {
    const opQueue = fakeQueue();
    const win = fakeWindow();
    const panel = mountSectionPanel(SLIDER_SECTION, { api: sliderApi(), opQueue, win });
    await flush();

    const cleanEvent = new Event("beforeunload", { cancelable: true });
    win.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    const titleInput = panel.element.querySelector<HTMLInputElement>(".wx-section-field-input")!;
    titleInput.value = "Renamed";
    titleInput.dispatchEvent(new Event("blur"));

    const dirtyEvent = new Event("beforeunload", { cancelable: true });
    win.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);

    panel.teardown();
    const afterTeardownEvent = new Event("beforeunload", { cancelable: true });
    win.dispatchEvent(afterTeardownEvent);
    expect(afterTeardownEvent.defaultPrevented).toBe(false);
  });
});
