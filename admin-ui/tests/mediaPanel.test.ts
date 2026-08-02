import { describe, expect, it, vi } from "vitest";
import type { AdminApi, MediaItem } from "../src/api";
import { mountMediaPanel } from "../src/mediaPanel";

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

describe("mountMediaPanel", () => {
  it("renders a one-line header (Upload inside it) and embeds the media grid", async () => {
    const api = fakeApi({
      getMedia: vi.fn(async () => [
        {
          name: "hero.jpg",
          url: "/images/hero.jpg",
          contentSrc: "images/hero.jpg",
          source: "repo" as const,
          sizeBytes: 100,
          width: 10,
          height: 10,
          references: [],
        },
      ]),
    });
    const panel = mountMediaPanel(api);
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.querySelector("h2")?.textContent).toBe("Media");
    expect(panel.element.querySelector(".wx-media-grid-root")).not.toBeNull();
    // one-line header: Upload lives in the header row, not a separate toolbar line
    const headerRow = panel.element.querySelector(".wx-media-header-row");
    expect(headerRow).not.toBeNull();
    expect(headerRow?.querySelector(".wx-media-upload-button")).not.toBeNull();
    // thumbnails are buttons that open the detail sheet (decisions/00080)
    expect(panel.element.querySelector(".wx-media-thumb")?.tagName).toBe("BUTTON");
  });

  it("teardown does not throw", () => {
    const panel = mountMediaPanel(fakeApi());
    expect(() => panel.teardown()).not.toThrow();
  });

  it("staging a replacement from the detail sheet fires onChanged (decisions/00108)", async () => {
    // The status bar's opCount (and so the Publish button's visibility) only
    // re-reads state when told to — a staged replacement produces no draft
    // PATCH, so the panel must say when its mutations land.
    const api = fakeApi({
      getMedia: vi.fn(async () => [
        {
          name: "hero.jpg",
          url: "/images/hero.jpg",
          contentSrc: "images/hero.jpg",
          source: "repo" as const,
          sizeBytes: 100,
          width: 10,
          height: 10,
          references: [],
        },
      ]),
      replaceMedia: vi.fn(async () => ({} as MediaItem)),
      unstageReplaceMedia: vi.fn(),
      unstageDeleteMedia: vi.fn(),
    });
    const onChanged = vi.fn();
    const panel = mountMediaPanel(api, undefined, onChanged);
    await Promise.resolve();
    await Promise.resolve();
    expect(onChanged).not.toHaveBeenCalled();

    panel.element.querySelector<HTMLButtonElement>(".wx-media-thumb")?.click();
    const backdrop = document.querySelector(".wx-media-dialog-backdrop");
    expect(backdrop).not.toBeNull();
    const replaceInput = backdrop?.querySelector<HTMLInputElement>('input[type="file"]');
    expect(replaceInput).not.toBeNull();
    const file = new File(["x"], "hero.jpg", { type: "image/jpeg" });
    Object.defineProperty(replaceInput, "files", { value: [file], configurable: true });
    replaceInput?.dispatchEvent(new Event("change"));
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(api.replaceMedia).toHaveBeenCalledWith("hero.jpg", file);
    expect(onChanged).toHaveBeenCalledTimes(1);
    panel.teardown();
  });
});
