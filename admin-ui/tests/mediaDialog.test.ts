import { describe, expect, it, vi } from "vitest";
import type { AdminApi, MediaItem } from "../src/api";
import {
  guessAltFromFilename,
  mountMediaDialog,
  openMediaDialog,
  renderMediaGrid,
} from "../src/mediaDialog";

describe("guessAltFromFilename", () => {
  it("strips the extension and title-cases dash/underscore-separated words", () => {
    expect(guessAltFromFilename("hero-image.jpg")).toBe("Hero Image");
  });

  it("strips the upload pipeline's <hash8>- prefix (wixy_server/media.py's _slugify)", () => {
    expect(guessAltFromFilename("a1b2c3d4-cottage-garden.jpg")).toBe("Cottage Garden");
  });

  it("leaves a repo filename (no hash prefix) alone besides the extension", () => {
    expect(guessAltFromFilename("hero.jpg")).toBe("Hero");
  });

  it("does not mistake a non-hex 8-char prefix for the upload hash", () => {
    expect(guessAltFromFilename("greenhouse-photo.jpg")).toBe("Greenhouse Photo");
  });
});

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    getState: vi.fn(),
    getContent: vi.fn(),
    patchDraft: vi.fn(),
    discardDraft: vi.fn(),
    getMedia: vi.fn(async (): Promise<MediaItem[]> => []),
    uploadMedia: vi.fn(),
    deleteMedia: vi.fn(),
    getTheme: vi.fn(),
    ...overrides,
  } as AdminApi;
}

function fakeWin(): Window {
  return {
    confirm: vi.fn(() => true),
    alert: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as Window;
}

const REPO_ITEM: MediaItem = {
  name: "hero.jpg",
  url: "/images/hero.jpg",
  source: "repo",
  sizeBytes: 204_800,
  width: 1200,
  height: 800,
  references: ["hero.bg"],
};

const UNREFERENCED_DRAFT_ITEM: MediaItem = {
  name: "a1b2c3d4-new.jpg",
  url: "/admin/draft-media/a1b2c3d4-new.jpg",
  source: "draft",
  sizeBytes: 51_200,
  width: 600,
  height: 400,
  references: [],
};

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("renderMediaGrid (management mode, no onPick)", () => {
  it("renders one item per media entry with dimensions, size, and reference count", async () => {
    const api = fakeApi({ getMedia: vi.fn(async () => [REPO_ITEM]) });
    const grid = renderMediaGrid({ api, win: fakeWin() });
    await flush();

    const cell = grid.element.querySelector(".wx-media-item");
    expect(cell?.textContent).toContain("1200×800");
    expect(cell?.textContent).toContain("200 KB");
    expect(cell?.textContent).toContain("1 use");
  });

  it("shows an empty state with no media", async () => {
    const api = fakeApi();
    const grid = renderMediaGrid({ api, win: fakeWin() });
    await flush();
    expect(grid.element.querySelector(".wx-media-empty")).not.toBeNull();
  });

  it("marks a draft-sourced item with the draft badge", async () => {
    const api = fakeApi({ getMedia: vi.fn(async () => [UNREFERENCED_DRAFT_ITEM]) });
    const grid = renderMediaGrid({ api, win: fakeWin() });
    await flush();
    expect(grid.element.querySelector(".wx-media-badge")?.textContent).toBe("draft");
  });

  it("thumbnails are buttons that open the detail sheet when onPick is omitted", async () => {
    const api = fakeApi({ getMedia: vi.fn(async () => [REPO_ITEM]) });
    const grid = renderMediaGrid({ api, win: fakeWin() });
    await flush();
    const thumb = grid.element.querySelector<HTMLButtonElement>(".wx-media-thumb");
    expect(thumb?.tagName).toBe("BUTTON");
    thumb?.click();
    const sheet = document.querySelector(".wx-media-detail");
    expect(sheet).not.toBeNull();
    expect(sheet?.textContent).toContain("hero.jpg");
    expect(sheet?.textContent).toContain("1200×800");
    expect(sheet?.textContent).toContain("hero.bg");
    (sheet?.querySelector(".wx-drawer-close") as HTMLButtonElement).click();
    expect(document.querySelector(".wx-media-detail")).toBeNull();
  });

  it("the detail sheet's Replace button calls replaceMedia and refreshes", async () => {
    const replaceMedia = vi.fn(async (): Promise<MediaItem> => REPO_ITEM);
    const getMedia = vi.fn().mockResolvedValue([REPO_ITEM]);
    const api = fakeApi({ getMedia, replaceMedia });
    const grid = renderMediaGrid({ api, win: fakeWin() });
    await flush();

    grid.element.querySelector<HTMLButtonElement>(".wx-media-thumb")?.click();
    const sheet = document.querySelector(".wx-media-detail");
    const replaceBtn = sheet?.querySelector<HTMLButtonElement>(".wx-media-detail-replace");
    replaceBtn?.click(); // opens the hidden file input
    const input = sheet?.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(["x"], "new.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input?.dispatchEvent(new Event("change"));
    await flush();

    expect(replaceMedia).toHaveBeenCalledWith("hero.jpg", file);
    expect(document.querySelector(".wx-media-detail")).toBeNull(); // closed after success
  });

  it("the detail sheet stages an unreferenced repo image's delete and closes", async () => {
    const unreferencedRepo: MediaItem = { ...REPO_ITEM, references: [] };
    const deleteMedia = vi.fn(async () => ({ stagedDelete: true }));
    const api = fakeApi({
      getMedia: vi.fn(async () => [unreferencedRepo]),
      deleteMedia,
    });
    const win = fakeWin();
    const grid = renderMediaGrid({ api, win });
    await flush();

    grid.element.querySelector<HTMLButtonElement>(".wx-media-thumb")?.click();
    const sheet = document.querySelector(".wx-media-detail");
    const deleteBtn = sheet?.querySelector<HTMLButtonElement>(".wx-media-delete");
    expect(deleteBtn?.disabled).toBe(false);
    deleteBtn?.click();
    await flush();

    expect(deleteMedia).toHaveBeenCalledWith("hero.jpg");
    expect(document.querySelector(".wx-media-detail")).toBeNull();
  });

  it("renders staged badges and unstages from the detail sheet", async () => {
    const staged: MediaItem = {
      ...REPO_ITEM,
      references: [],
      stagedReplace: true,
      stagedDelete: true,
      url: "/admin/draft-media-replace/hero.jpg",
    };
    const unstageReplaceMedia = vi.fn(async () => ({ deleted: true }));
    const unstageDeleteMedia = vi.fn(async () => ({ deleted: true }));
    const api = fakeApi({
      getMedia: vi.fn(async () => [staged]),
      unstageReplaceMedia,
      unstageDeleteMedia,
    });
    const grid = renderMediaGrid({ api, win: fakeWin() });
    await flush();

    expect(grid.element.querySelector(".wx-media-badge-staged")?.textContent).toBe("replace staged");
    expect(grid.element.querySelector(".wx-media-badge-delete-staged")?.textContent).toBe("delete staged");
    expect(grid.element.querySelector(".wx-media-item-staged-delete")).not.toBeNull();

    grid.element.querySelector<HTMLButtonElement>(".wx-media-thumb")?.click();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".wx-media-detail-actions button")];
    const undoReplace = buttons.find((b) => b.textContent === "Undo staged replace");
    const undoDelete = buttons.find((b) => b.textContent === "Undo staged delete");
    expect(undoReplace).not.toBeUndefined();
    expect(undoDelete).not.toBeUndefined();
    undoReplace?.click();
    await flush();
    expect(unstageReplaceMedia).toHaveBeenCalledWith("hero.jpg");
  });

  it("mounts the Upload button into a provided headerRow instead of the toolbar", async () => {
    const headerRow = document.createElement("div");
    const api = fakeApi();
    renderMediaGrid({ api, win: fakeWin(), headerRow });
    await flush();
    expect(headerRow.querySelector(".wx-media-upload-button")).not.toBeNull();
  });

  it("disables delete for a repo-sourced item", async () => {
    const api = fakeApi({ getMedia: vi.fn(async () => [REPO_ITEM]) });
    const grid = renderMediaGrid({ api, win: fakeWin() });
    await flush();
    const deleteButton = grid.element.querySelector<HTMLButtonElement>(".wx-media-delete");
    expect(deleteButton?.disabled).toBe(true);
  });

  it("disables delete for a referenced draft item", async () => {
    const referenced: MediaItem = { ...UNREFERENCED_DRAFT_ITEM, references: ["hero.bg"] };
    const api = fakeApi({ getMedia: vi.fn(async () => [referenced]) });
    const grid = renderMediaGrid({ api, win: fakeWin() });
    await flush();
    const deleteButton = grid.element.querySelector<HTMLButtonElement>(".wx-media-delete");
    expect(deleteButton?.disabled).toBe(true);
  });

  it("delete is enabled for an unreferenced draft item and, after confirm, calls the API and refreshes", async () => {
    const deleteMedia = vi.fn(async () => ({ deleted: true }));
    const getMedia = vi
      .fn()
      .mockResolvedValueOnce([UNREFERENCED_DRAFT_ITEM])
      .mockResolvedValueOnce([]);
    const api = fakeApi({ getMedia, deleteMedia });
    const win = fakeWin();
    const grid = renderMediaGrid({ api, win });
    await flush();

    const deleteButton = grid.element.querySelector<HTMLButtonElement>(".wx-media-delete");
    expect(deleteButton?.disabled).toBe(false);
    deleteButton?.click();
    await flush();

    expect(win.confirm).toHaveBeenCalled();
    expect(deleteMedia).toHaveBeenCalledWith("a1b2c3d4-new.jpg");
    expect(getMedia).toHaveBeenCalledTimes(2);
  });

  it("skips the delete call when the user declines the confirm", async () => {
    const deleteMedia = vi.fn();
    const api = fakeApi({ getMedia: vi.fn(async () => [UNREFERENCED_DRAFT_ITEM]), deleteMedia });
    const win = { ...fakeWin(), confirm: vi.fn(() => false) } as unknown as Window;
    const grid = renderMediaGrid({ api, win });
    await flush();

    grid.element.querySelector<HTMLButtonElement>(".wx-media-delete")?.click();
    await flush();
    expect(deleteMedia).not.toHaveBeenCalled();
  });

  it("uploading via the file input calls uploadMedia and refreshes the grid", async () => {
    const uploadMedia = vi.fn(async () => UNREFERENCED_DRAFT_ITEM);
    const getMedia = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([UNREFERENCED_DRAFT_ITEM]);
    const api = fakeApi({ getMedia, uploadMedia });
    const grid = renderMediaGrid({ api, win: fakeWin() });
    await flush();

    const file = new File([new Uint8Array([1, 2, 3])], "new.jpg", { type: "image/jpeg" });
    const fileInput = grid.element.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    if (fileInput === null) return;
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fileInput.dispatchEvent(new Event("change"));
    await flush();

    expect(uploadMedia).toHaveBeenCalledWith(file);
    expect(getMedia).toHaveBeenCalledTimes(2);
  });

  it("dropping a file onto the grid uploads it", async () => {
    const uploadMedia = vi.fn(async () => UNREFERENCED_DRAFT_ITEM);
    const api = fakeApi({ uploadMedia });
    const grid = renderMediaGrid({ api, win: fakeWin() });
    await flush();

    const file = new File([new Uint8Array([1])], "dropped.jpg", { type: "image/jpeg" });
    const dropEvent = Object.assign(new Event("drop"), { dataTransfer: { files: [file] } });
    grid.element.dispatchEvent(dropEvent);
    await flush();

    expect(uploadMedia).toHaveBeenCalledWith(file);
  });

  it("surfaces an upload failure via win.alert without crashing", async () => {
    const uploadMedia = vi.fn(async () => {
      throw new Error("file exceeds the 15MB limit");
    });
    const api = fakeApi({ uploadMedia });
    const win = fakeWin();
    const grid = renderMediaGrid({ api, win });
    await flush();

    const file = new File([new Uint8Array([1])], "big.jpg", { type: "image/jpeg" });
    const fileInput = grid.element.querySelector<HTMLInputElement>('input[type="file"]');
    if (fileInput === null) throw new Error("expected a file input");
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fileInput.dispatchEvent(new Event("change"));
    await flush();

    expect(win.alert).toHaveBeenCalledWith("file exceeds the 15MB limit");
  });
});

describe("renderMediaGrid (pick mode, onPick provided)", () => {
  it("clicking a thumbnail opens the alt-text step pre-filled with a filename guess", async () => {
    const api = fakeApi({ getMedia: vi.fn(async () => [UNREFERENCED_DRAFT_ITEM]) });
    const grid = renderMediaGrid({ api, win: fakeWin(), onPick: vi.fn() });
    await flush();

    grid.element.querySelector<HTMLButtonElement>(".wx-media-thumb")?.click();

    const altInput = grid.element.querySelector<HTMLInputElement>(".wx-media-alt-step input[type=text]");
    expect(altInput?.value).toBe("New");
  });

  it("confirm calls onPick with the entered alt text", async () => {
    const api = fakeApi({ getMedia: vi.fn(async () => [UNREFERENCED_DRAFT_ITEM]) });
    const onPick = vi.fn();
    const grid = renderMediaGrid({ api, win: fakeWin(), onPick });
    await flush();

    grid.element.querySelector<HTMLButtonElement>(".wx-media-thumb")?.click();
    const altInput = grid.element.querySelector<HTMLInputElement>(".wx-media-alt-step input[type=text]");
    if (altInput === null) throw new Error("expected an alt input");
    altInput.value = "A lovely garden";
    altInput.dispatchEvent(new Event("input"));
    const confirmButton = Array.from(grid.element.querySelectorAll("button")).find(
      (b) => b.textContent === "Use this image",
    );
    confirmButton?.click();

    expect(onPick).toHaveBeenCalledWith({
      src: "/admin/draft-media/a1b2c3d4-new.jpg",
      alt: "A lovely garden",
    });
  });

  it("Confirm is disabled on empty alt unless Decorative is checked, which then forces alt to empty", async () => {
    const api = fakeApi({ getMedia: vi.fn(async () => [UNREFERENCED_DRAFT_ITEM]) });
    const onPick = vi.fn();
    const grid = renderMediaGrid({ api, win: fakeWin(), onPick });
    await flush();

    grid.element.querySelector<HTMLButtonElement>(".wx-media-thumb")?.click();
    const altInput = grid.element.querySelector<HTMLInputElement>(".wx-media-alt-step input[type=text]");
    const confirmButton = Array.from(grid.element.querySelectorAll("button")).find(
      (b) => b.textContent === "Use this image",
    );
    if (altInput === null || confirmButton === undefined) throw new Error("expected alt input + confirm button");

    altInput.value = "";
    altInput.dispatchEvent(new Event("input"));
    expect(confirmButton.disabled).toBe(true);

    const decorativeBox = grid.element.querySelector<HTMLInputElement>('.wx-media-alt-step input[type="checkbox"]');
    if (decorativeBox === null) throw new Error("expected a decorative checkbox");
    decorativeBox.checked = true;
    decorativeBox.dispatchEvent(new Event("change"));
    expect(confirmButton.disabled).toBe(false);

    confirmButton.click();
    expect(onPick).toHaveBeenCalledWith({ src: UNREFERENCED_DRAFT_ITEM.url, alt: "" });
  });

  it("Back returns to the grid without picking", async () => {
    const api = fakeApi({ getMedia: vi.fn(async () => [UNREFERENCED_DRAFT_ITEM]) });
    const onPick = vi.fn();
    const grid = renderMediaGrid({ api, win: fakeWin(), onPick });
    await flush();

    grid.element.querySelector<HTMLButtonElement>(".wx-media-thumb")?.click();
    const backButton = Array.from(grid.element.querySelectorAll("button")).find((b) => b.textContent === "Back");
    backButton?.click();

    expect(onPick).not.toHaveBeenCalled();
    expect(grid.element.querySelector(".wx-media-grid")?.hasAttribute("hidden")).toBe(false);
  });
});

describe("mountMediaDialog / openMediaDialog", () => {
  it("openMediaDialog appends the dialog to document.body", () => {
    const api = fakeApi();
    openMediaDialog({ api, win: fakeWin() }, vi.fn());
    expect(document.querySelector(".wx-media-dialog-backdrop")).not.toBeNull();
    document.querySelector(".wx-media-dialog-backdrop")?.remove();
  });

  it("clicking the backdrop (not the box) cancels with null", () => {
    const api = fakeApi();
    const respond = vi.fn();
    openMediaDialog({ api, win: fakeWin() }, respond);

    const backdrop = document.querySelector(".wx-media-dialog-backdrop");
    backdrop?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(respond).toHaveBeenCalledWith(null);
    expect(document.querySelector(".wx-media-dialog-backdrop")).toBeNull();
  });

  it("clicking inside the dialog box does not cancel", () => {
    const api = fakeApi();
    const respond = vi.fn();
    openMediaDialog({ api, win: fakeWin() }, respond);

    document.querySelector(".wx-media-dialog")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(respond).not.toHaveBeenCalled();
    document.querySelector(".wx-media-dialog-backdrop")?.remove();
  });

  it("the close button cancels with null", () => {
    const api = fakeApi();
    const respond = vi.fn();
    openMediaDialog({ api, win: fakeWin() }, respond);

    document.querySelector<HTMLButtonElement>(".wx-drawer-close")?.click();
    expect(respond).toHaveBeenCalledWith(null);
  });

  it("picking an image resolves respond() with the value and removes the dialog", async () => {
    const api = fakeApi({ getMedia: vi.fn(async () => [UNREFERENCED_DRAFT_ITEM]) });
    const respond = vi.fn();
    openMediaDialog({ api, win: fakeWin() }, respond);
    await flush();

    document.querySelector<HTMLButtonElement>(".wx-media-thumb")?.click();
    const confirmButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Use this image",
    );
    confirmButton?.click();

    expect(respond).toHaveBeenCalledWith({ src: UNREFERENCED_DRAFT_ITEM.url, alt: "New" });
    expect(document.querySelector(".wx-media-dialog-backdrop")).toBeNull();
  });

  it("mountMediaDialog's Escape-key listener is removed on teardown", () => {
    const api = fakeApi();
    const win = fakeWin();
    const dialog = mountMediaDialog({ api, win }, { onPick: vi.fn(), onCancel: vi.fn() });
    dialog.teardown();
    expect(win.removeEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
  });
});
