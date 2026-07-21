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
});
