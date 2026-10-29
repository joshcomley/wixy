// The ⋯ menu's Gallery entry inside the real thread view (workspace 00046): it is in the menu,
// opens the gallery under the header, and every lock closes it again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GalleryItem } from "../src/server/api/gallery";
import type { HistoryPage } from "../src/server/api/messages";
import type { ServerIdentity } from "../src/server/identity";
import { mountServerThread } from "../src/server/thread";
import type { LockHooks, ServerSession } from "../src/server/types";

const { getHistory, getUsage, getGalleryPage } = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getUsage: vi.fn(),
  getGalleryPage: vi.fn(),
}));
vi.mock("../src/server/api/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/messages")>()),
  getHistory,
  getUsage,
}));
vi.mock("../src/server/api/gallery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/gallery")>()),
  getGalleryPage,
}));

const SESSION: ServerSession = { token: "tok", expiresAt: 0 };

function galleryItem(seq: number): GalleryItem {
  return {
    id: `id${seq}`,
    kind: "photo",
    seq,
    ordinal: 0,
    width: 10,
    height: 10,
    durationS: null,
    createdAt: 1_700_000_000,
    animated: false,
    urls: { thumb: `/t/${seq}`, full: `/f/${seq}` },
    downloadUrl: `/d/${seq}`,
    filename: `wixy-${seq}.jpg`,
  };
}

function identity(): ServerIdentity {
  return {
    getName: () => "Josh",
    setName: vi.fn(),
    getDeviceId: () => "device-1234",
    isMine: () => true,
  } as unknown as ServerIdentity;
}

function hooks(): LockHooks {
  return {
    suspend: vi.fn(() => () => {}),
    lockNow: vi.fn(),
    adoptBoundSession: vi.fn(),
    getBoundGrantId: vi.fn(() => null), suspendLive: vi.fn(() => ({ touch() {}, release() {} })), activityCount: vi.fn(() => 0),
  };
}

function win(): Window {
  return {
    crypto: { randomUUID: () => "uuid-1" },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    navigator: window.navigator,
  } as unknown as Window;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount() {
  getHistory.mockResolvedValue({ messages: [], hasMore: false, cursor: 0 } satisfies HistoryPage);
  const view = mountServerThread({ identity: identity(), hooks: hooks(), win: win(), onSettings: vi.fn() });
  document.body.appendChild(view.element);
  await view.attach(SESSION);
  await settle();
  return view;
}

function openGallery(view: { element: HTMLElement }): void {
  view.element.querySelector<HTMLButtonElement>(".wx-srv-more-button")!.click();
  view.element.querySelector<HTMLButtonElement>(".wx-srv-more-gallery")!.click();
}

beforeEach(() => {
  getHistory.mockReset();
  getUsage
    .mockReset()
    .mockResolvedValue({ mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false });
  getGalleryPage.mockReset().mockResolvedValue({ items: [galleryItem(2), galleryItem(1)], hasMore: false });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("Gallery in the More menu", () => {
  it("is the first entry, with a hint", async () => {
    const view = await mount();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-more-button")!.click();

    const first = view.element.querySelector(".wx-srv-more-menu .wx-srv-more-item");
    expect(first?.classList.contains("wx-srv-more-gallery")).toBe(true);
    expect(first?.querySelector(".wx-srv-more-item-title")?.textContent).toBe("Gallery");
    expect(first?.querySelector(".wx-srv-more-item-hint")?.textContent).toBe("Every photo and video, with downloads");
    view.teardown();
  });

  it("opens the gallery, closing the menu", async () => {
    const view = await mount();
    openGallery(view);
    await settle();

    expect(view.element.querySelector<HTMLElement>(".wx-srv-more-menu")!.hidden).toBe(true);
    expect(view.element.querySelector<HTMLElement>(".wx-srv-gallery-view")!.hidden).toBe(false);
    expect(view.element.querySelectorAll(".wx-srv-gallery-tile")).toHaveLength(2);
    expect(getGalleryPage).toHaveBeenCalledWith(SESSION, { limit: 60 });
    view.teardown();
  });

  it("a lock (detach) closes it and drops every tile", async () => {
    const view = await mount();
    openGallery(view);
    await settle();

    view.detach();

    expect(view.element.querySelector<HTMLElement>(".wx-srv-gallery-view")!.hidden).toBe(true);
    expect(view.element.querySelector(".wx-srv-gallery-tile")).toBeNull();
    view.teardown();
  });

  it("a renewed session while open re-fetches for fresh links", async () => {
    const view = await mount();
    openGallery(view);
    await settle();
    getGalleryPage.mockClear();

    await view.attach({ token: "renewed", expiresAt: 1 });
    await settle();

    expect(getGalleryPage).toHaveBeenCalledWith({ token: "renewed", expiresAt: 1 }, { limit: 2 });
    view.teardown();
  });
});
