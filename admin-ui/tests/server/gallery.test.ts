// The Server chat gallery (workspace 00046): the page parser and request, the per-device
// "downloaded up to here" mark, and the screen — grid, viewer, per-item and bulk downloads.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGalleryPage, parseGalleryItem, type GalleryItem, type GalleryPage } from "../../src/server/api/gallery";
import { ServerLockedError } from "../../src/server/api/http";
import { createGallery, type GalleryView } from "../../src/server/gallery";
import {
  DOWNLOAD_MARK_KEY,
  createDownloadMarkStore,
  isAfterMark,
  type DownloadMark,
  type DownloadMarkStore,
} from "../../src/server/galleryMark";
import type { ServerSession } from "../../src/server/types";

const SESSION: ServerSession = { token: "tok", expiresAt: 0 };

function item(seq: number, over: Partial<GalleryItem> = {}): GalleryItem {
  return {
    id: `id${seq}`,
    kind: "photo",
    seq,
    ordinal: 0,
    width: 40,
    height: 30,
    durationS: null,
    createdAt: 1_700_000_000 + seq,
    animated: false,
    urls: { thumb: `/t/${seq}`, full: `/f/${seq}` },
    downloadUrl: `/d/${seq}?dl=1`,
    filename: `wixy-${seq}.jpg`,
    ...over,
  };
}

function video(seq: number): GalleryItem {
  return item(seq, {
    kind: "video",
    durationS: 75,
    urls: { thumb: `/t/${seq}`, poster: `/p/${seq}`, play: `/v/${seq}` },
    downloadUrl: `/d/${seq}?dl=1`,
    filename: `wixy-${seq}.mp4`,
  });
}

// -- API ---------------------------------------------------------------------------------

describe("parseGalleryItem", () => {
  it("keeps a well-formed item and falls back on a missing filename", () => {
    const parsed = parseGalleryItem({
      id: "abcdef123456",
      kind: "video",
      seq: 3,
      ordinal: 1,
      durationS: 12,
      createdAt: 5,
      urls: { thumb: "/t", play: "/v", bogus: "/x" },
      downloadUrl: "/d",
    });
    expect(parsed).toMatchObject({
      id: "abcdef123456",
      kind: "video",
      seq: 3,
      ordinal: 1,
      durationS: 12,
      urls: { thumb: "/t", play: "/v" },
      downloadUrl: "/d",
      filename: "wixy-abcdef12",
    });
  });

  it.each([
    null,
    "x",
    { id: "a", kind: "voice", seq: 1, ordinal: 0 },
    { id: "", kind: "photo", seq: 1, ordinal: 0 },
    { id: "a", kind: "photo", ordinal: 0 },
    { id: "a", kind: "photo", seq: 1 },
  ])("drops %j", (raw) => {
    expect(parseGalleryItem(raw)).toBeNull();
  });
});

describe("getGalleryPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for the page after a cursor and drops unparseable items", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [{ id: "a", kind: "photo", seq: 5, ordinal: 0 }, { nonsense: true }],
          hasMore: true,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const page = await getGalleryPage(SESSION, { before: { seq: 9, ordinal: 2 }, limit: 30 });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/server/gallery?before=9.2&limit=30");
    expect(page.items.map((i) => i.id)).toEqual(["a"]);
    expect(page.hasMore).toBe(true);
  });

  it("throws a plain error on a non-OK answer and ServerLockedError on a 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("", { status: 500 })));
    await expect(getGalleryPage(SESSION)).rejects.toThrow("Couldn't load the gallery (500).");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("", { status: 401 })));
    await expect(getGalleryPage(SESSION)).rejects.toBeInstanceOf(ServerLockedError);
  });
});

// -- Mark --------------------------------------------------------------------------------

describe("download mark", () => {
  it("round-trips through localStorage", () => {
    window.localStorage.clear();
    const store = createDownloadMarkStore(window);
    expect(store.read()).toBeNull();
    store.write({ seq: 7, ordinal: 1, at: 123 });
    expect(createDownloadMarkStore(window).read()).toEqual({ seq: 7, ordinal: 1, at: 123 });
  });

  it.each(["not json", '{"seq":"7","ordinal":0,"at":1}', '{"seq":1.5,"ordinal":0,"at":1}', "null"])(
    "treats %s as no mark",
    (raw) => {
      window.localStorage.setItem(DOWNLOAD_MARK_KEY, raw);
      expect(createDownloadMarkStore(window).read()).toBeNull();
    },
  );

  it("survives storage that throws", () => {
    const hostile = {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    } as unknown as Window;
    const store = createDownloadMarkStore(hostile);
    expect(store.read()).toBeNull();
    expect(() => store.write({ seq: 1, ordinal: 0, at: 1 })).not.toThrow();
  });

  it("orders by message, then position within it", () => {
    const mark: DownloadMark = { seq: 5, ordinal: 1, at: 1 };
    expect(isAfterMark({ seq: 5, ordinal: 1 }, mark)).toBe(false);
    expect(isAfterMark({ seq: 5, ordinal: 2 }, mark)).toBe(true);
    expect(isAfterMark({ seq: 6, ordinal: 0 }, mark)).toBe(true);
    expect(isAfterMark({ seq: 4, ordinal: 9 }, mark)).toBe(false);
    expect(isAfterMark({ seq: 1, ordinal: 0 }, null)).toBe(true);
  });
});

// -- The screen -------------------------------------------------------------------------

class MemoryMark implements DownloadMarkStore {
  value: DownloadMark | null = null;
  writes: DownloadMark[] = [];
  read(): DownloadMark | null {
    return this.value;
  }
  write(mark: DownloadMark): void {
    this.value = mark;
    this.writes.push(mark);
  }
}

interface Harness {
  readonly gallery: GalleryView;
  readonly mark: MemoryMark;
  readonly lockNow: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
  readonly suspend: ReturnType<typeof vi.fn>;
  readonly fetchPage: ReturnType<typeof vi.fn>;
  readonly saved: string[];
  readonly fetched: string[];
  readonly fileFetch: ReturnType<typeof vi.fn>;
}

/** `pages` are served in order, one per request (the server sends newest first). */
function harness(pages: readonly GalleryPage[], options: { session?: ServerSession | null } = {}): Harness {
  const mark = new MemoryMark();
  const release = vi.fn();
  const suspend = vi.fn(() => release);
  const lockNow = vi.fn();
  const queue = [...pages];
  const fetchPage = vi.fn(async () => queue.shift() ?? { items: [], hasMore: false });
  const saved: string[] = [];
  const fetched: string[] = [];
  const fileFetch = vi.fn(async (url: string) => {
    fetched.push(url);
    return new Response(new Blob([url]), { status: 200 });
  });
  const gallery = createGallery({
    document,
    win: window,
    fetch: fileFetch as unknown as typeof fetch,
    hooks: { suspend, lockNow },
    getSession: () => (options.session === undefined ? SESSION : options.session),
    mark,
    fetchPage,
    downloadGapMs: 0,
    now: () => 4242,
  });
  document.body.appendChild(gallery.element);
  return { gallery, mark, lockNow, release, suspend, fetchPage, saved, fetched, fileFetch };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function q<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`missing ${selector}`);
  return found;
}

describe("gallery screen", () => {
  let clicks: { href: string; download: string | null }[];

  beforeEach(() => {
    document.body.replaceChildren();
    clicks = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.getAttribute("download") });
    });
    let n = 0;
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => `blob:fake/${(n += 1)}`);
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a thumbnail tile per item with its own Download link, a duration badge on videos", async () => {
    const h = harness([{ items: [video(3), item(2), item(1)], hasMore: false }]);
    h.gallery.open(48);
    await settle();

    const tiles = h.gallery.element.querySelectorAll(".wx-srv-gallery-tile");
    expect(tiles).toHaveLength(3);
    expect(h.gallery.element.hidden).toBe(false);
    expect(h.gallery.element.style.top).toBe("48px");
    expect(q<HTMLImageElement>(tiles[0]!, "img").getAttribute("src")).toBe("/t/3");
    expect(q(tiles[0]!, ".wx-srv-gallery-badge").textContent).toBe("▶ 1:15");
    expect(tiles[1]!.querySelector(".wx-srv-gallery-badge")).toBeNull();
    const save = q<HTMLAnchorElement>(tiles[1]!, ".wx-srv-gallery-save");
    expect(save.getAttribute("href")).toBe("/d/2?dl=1");
    expect(save.getAttribute("download")).toBe("wixy-2.jpg");
    expect(q(h.gallery.element, ".wx-srv-gallery-count").textContent).toBe("3");
  });

  it("makes every control a gesture boundary so quick taps cannot lock the chat", async () => {
    const h = harness([{ items: [video(2), item(1)], hasMore: false }]);
    h.gallery.open(0);
    await settle();
    q<HTMLButtonElement>(h.gallery.element, ".wx-srv-gallery-open").click();

    const controls = h.gallery.element.querySelectorAll("button, a");
    expect(controls.length).toBeGreaterThan(8);
    for (const control of controls) {
      expect(control.hasAttribute("data-srv-gesture-boundary"), control.className).toBe(true);
    }
  });

  it("pages in the rest of the history behind the first screenful", async () => {
    const h = harness([
      { items: [item(4), item(3)], hasMore: true },
      { items: [item(2), item(1)], hasMore: false },
    ]);
    h.gallery.open(0);
    await settle();

    expect(h.fetchPage).toHaveBeenCalledTimes(2);
    expect(h.fetchPage.mock.calls[0]?.[1]).toEqual({ limit: 60 });
    expect(h.fetchPage.mock.calls[1]?.[1]).toEqual({ before: { seq: 3, ordinal: 0 }, limit: 200 });
    expect(h.gallery.element.querySelectorAll(".wx-srv-gallery-tile")).toHaveLength(4);
  });

  it("says so when there is nothing to show", async () => {
    const h = harness([{ items: [], hasMore: false }]);
    h.gallery.open(0);
    await settle();

    expect(q<HTMLElement>(h.gallery.element, ".wx-srv-gallery-empty").hidden).toBe(false);
    expect(q<HTMLButtonElement>(h.gallery.element, ".wx-srv-gallery-download-all").disabled).toBe(true);
  });

  it("locks on a 401 and offers a retry on any other failure", async () => {
    const locked = harness([]);
    locked.fetchPage.mockRejectedValueOnce(new ServerLockedError());
    locked.gallery.open(0);
    await settle();
    expect(locked.lockNow).toHaveBeenCalledWith("unauthorized");

    document.body.replaceChildren();
    const failing = harness([]);
    failing.fetchPage.mockRejectedValueOnce(new Error("Couldn't load the gallery (500)."));
    failing.gallery.open(0);
    await settle();
    expect(q(failing.gallery.element, ".wx-srv-gallery-error").textContent).toBe("Couldn't load the gallery (500).");
    expect(q<HTMLElement>(failing.gallery.element, ".wx-srv-gallery-retry").hidden).toBe(false);
  });

  describe("viewer", () => {
    it("opens a photo full size, steps between items, and closes", async () => {
      const h = harness([{ items: [item(3), item(2), item(1)], hasMore: false }]);
      h.gallery.open(0);
      await settle();

      q<HTMLButtonElement>(h.gallery.element, ".wx-srv-gallery-tile:nth-child(2) .wx-srv-gallery-open").click();
      const viewer = q(h.gallery.element, ".wx-srv-gallery-viewer");
      expect(q<HTMLImageElement>(viewer, "img").getAttribute("src")).toBe("/f/2");
      expect(q(viewer, ".wx-srv-gallery-position").textContent).toBe("2 / 3");
      expect(q<HTMLAnchorElement>(viewer, ".wx-srv-gallery-viewer-save").getAttribute("href")).toBe("/d/2?dl=1");

      q<HTMLButtonElement>(viewer, ".wx-srv-gallery-next").click();
      expect(q<HTMLImageElement>(viewer, "img").getAttribute("src")).toBe("/f/1");
      expect(q<HTMLButtonElement>(viewer, ".wx-srv-gallery-next").disabled).toBe(true);
      q<HTMLButtonElement>(viewer, ".wx-srv-gallery-prev").click();
      q<HTMLButtonElement>(viewer, ".wx-srv-gallery-prev").click();
      expect(q<HTMLImageElement>(viewer, "img").getAttribute("src")).toBe("/f/3");

      q<HTMLButtonElement>(viewer, ".wx-srv-gallery-viewer-close").click();
      expect(h.gallery.element.querySelector(".wx-srv-gallery-viewer")).toBeNull();
    });

    it("plays a video in a real player and lets go of it on close", async () => {
      const h = harness([{ items: [video(2)], hasMore: false }]);
      h.gallery.open(0);
      await settle();

      q<HTMLButtonElement>(h.gallery.element, ".wx-srv-gallery-open").click();
      const player = q<HTMLVideoElement>(h.gallery.element, ".wx-srv-gallery-viewer video");
      expect(player.controls).toBe(true);
      expect(player.getAttribute("src")).toBe("/v/2");
      expect(player.getAttribute("poster")).toBe("/p/2");

      q<HTMLButtonElement>(h.gallery.element, ".wx-srv-gallery-viewer-close").click();
      expect(player.hasAttribute("src")).toBe(false);
      expect(h.gallery.element.querySelector("video")).toBeNull();
    });

    it("closing the whole gallery closes the viewer too", async () => {
      const h = harness([{ items: [item(1)], hasMore: false }]);
      h.gallery.open(0);
      await settle();
      q<HTMLButtonElement>(h.gallery.element, ".wx-srv-gallery-open").click();

      h.gallery.close();

      expect(h.gallery.isOpen()).toBe(false);
      expect(h.gallery.element.hidden).toBe(true);
      expect(h.gallery.element.querySelector(".wx-srv-gallery-viewer")).toBeNull();
      expect(h.gallery.element.querySelector(".wx-srv-gallery-tile")).toBeNull();
    });
  });

  describe("Download Any Undownloaded", () => {
    const downloadAll = (h: Harness): HTMLButtonElement =>
      q<HTMLButtonElement>(h.gallery.element, ".wx-srv-gallery-download-all");

    it("counts what is new and saves it oldest first, one file at a time", async () => {
      const h = harness([{ items: [item(3), video(2), item(1)], hasMore: false }]);
      h.gallery.open(0);
      await settle();
      expect(downloadAll(h).textContent).toBe("Download Any Undownloaded (3)");

      downloadAll(h).click();
      await settle();

      expect(h.fetched).toEqual(["/d/1?dl=1", "/d/2?dl=1", "/d/3?dl=1"]);
      expect(clicks.map((c) => c.download)).toEqual(["wixy-1.jpg", "wixy-2.mp4", "wixy-3.jpg"]);
      expect(clicks.every((c) => c.href.startsWith("blob:fake/"))).toBe(true);
      expect(h.mark.writes).toEqual([
        { seq: 1, ordinal: 0, at: 4242 },
        { seq: 2, ordinal: 0, at: 4242 },
        { seq: 3, ordinal: 0, at: 4242 },
      ]);
      expect(q(h.gallery.element, ".wx-srv-gallery-status").textContent).toBe("Downloaded 3 files.");
      expect(downloadAll(h).disabled).toBe(true);
    });

    it("on a later visit only fetches what was sent since the last run", async () => {
      const h = harness([{ items: [item(6), item(5), item(4), item(3)], hasMore: false }]);
      h.mark.value = { seq: 4, ordinal: 0, at: 1 };
      h.gallery.open(0);
      await settle();
      expect(downloadAll(h).textContent).toBe("Download Any Undownloaded (2)");

      downloadAll(h).click();
      await settle();

      expect(h.fetched).toEqual(["/d/5?dl=1", "/d/6?dl=1"]);
      expect(h.mark.value).toEqual({ seq: 6, ordinal: 0, at: 4242 });
    });

    it("has nothing to do when the device is up to date", async () => {
      const h = harness([{ items: [item(2), item(1)], hasMore: false }]);
      h.mark.value = { seq: 2, ordinal: 0, at: 1 };
      h.gallery.open(0);
      await settle();

      expect(downloadAll(h).disabled).toBe(true);
      expect(q(h.gallery.element, ".wx-srv-gallery-status").textContent).toBe(
        "Everything is already downloaded on this device.",
      );
    });

    it("stays disabled until the whole history is known", async () => {
      const h = harness([{ items: [item(2)], hasMore: true }]);
      let finish: (page: GalleryPage) => void = () => {};
      h.fetchPage.mockImplementationOnce(async () => ({ items: [item(2)], hasMore: true }));
      h.fetchPage.mockImplementationOnce(() => new Promise<GalleryPage>((resolve) => (finish = resolve)));
      h.gallery.open(0);
      await settle();
      expect(downloadAll(h).disabled).toBe(true);

      finish({ items: [item(1)], hasMore: false });
      await settle();
      expect(downloadAll(h).disabled).toBe(false);
    });

    it("stops at a failed file, keeps the mark at the last good one, and resumes there", async () => {
      const h = harness([{ items: [item(3), item(2), item(1)], hasMore: false }]);
      h.fileFetch.mockImplementation(async (url: string) => {
        h.fetched.push(url);
        return url.includes("/d/2") ? new Response("", { status: 403 }) : new Response(new Blob([url]));
      });
      h.gallery.open(0);
      await settle();

      downloadAll(h).click();
      await settle();

      expect(h.fetched).toEqual(["/d/1?dl=1", "/d/2?dl=1"]);
      expect(h.mark.value).toEqual({ seq: 1, ordinal: 0, at: 4242 });
      expect(q(h.gallery.element, ".wx-srv-gallery-status").textContent).toContain(
        "Stopped after 1 of 3: couldn't fetch wixy-2.jpg",
      );
      expect(downloadAll(h).textContent).toBe("Download Any Undownloaded (2)");
    });

    it("Stop ends the run after the file in hand", async () => {
      const h = harness([{ items: [item(3), item(2), item(1)], hasMore: false }]);
      let release: () => void = () => {};
      h.fileFetch.mockImplementation(async (url: string) => {
        h.fetched.push(url);
        if (url.includes("/d/1")) await new Promise<void>((resolve) => (release = resolve));
        return new Response(new Blob([url]));
      });
      h.gallery.open(0);
      await settle();

      downloadAll(h).click();
      await settle();
      const stop = q<HTMLButtonElement>(h.gallery.element, ".wx-srv-gallery-cancel");
      expect(stop.hidden).toBe(false);
      stop.click();
      release();
      await settle();

      expect(h.fetched).toEqual(["/d/1?dl=1"]);
      expect(h.mark.value).toBeNull();
      expect(stop.hidden).toBe(true);
      expect(q(h.gallery.element, ".wx-srv-gallery-status").textContent).toBe(
        "Stopped after 0 of 3. Tap again to carry on.",
      );
    });

    it("keeps the idle lock off while it runs and gives it back after", async () => {
      const h = harness([{ items: [item(2), item(1)], hasMore: false }]);
      h.gallery.open(0);
      await settle();

      downloadAll(h).click();
      await settle();

      expect(h.suspend).toHaveBeenCalledWith("mediaPlaying");
      expect(h.release).toHaveBeenCalledTimes(1);
    });

    it("closing the gallery mid-run (a lock) abandons it", async () => {
      const h = harness([{ items: [item(3), item(2), item(1)], hasMore: false }]);
      let release: () => void = () => {};
      h.fileFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        h.fetched.push(url);
        if (url.includes("/d/1")) {
          await new Promise<void>((resolve) => (release = resolve));
          if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
        }
        return new Response(new Blob([url]));
      });
      h.gallery.open(0);
      await settle();
      downloadAll(h).click();
      await settle();

      h.gallery.close();
      release();
      await settle();

      expect(h.fetched).toEqual(["/d/1?dl=1"]);
      expect(clicks).toHaveLength(0);
      expect(h.mark.writes).toHaveLength(0);
      expect(h.release).toHaveBeenCalledTimes(1);
    });
  });

  it("a renewed session swaps in fresh URLs without rebuilding the screen", async () => {
    const h = harness([{ items: [item(2), item(1)], hasMore: false }]);
    h.gallery.open(0);
    await settle();
    const firstTile = q(h.gallery.element, ".wx-srv-gallery-tile");
    h.fetchPage.mockResolvedValueOnce({
      items: [
        item(2, { urls: { thumb: "/t/2?new", full: "/f/2?new" }, downloadUrl: "/d/2?new" }),
        item(1, { urls: { thumb: "/t/1?new", full: "/f/1?new" }, downloadUrl: "/d/1?new" }),
      ],
      hasMore: false,
    });

    h.gallery.refreshSession();
    await settle();

    expect(q(h.gallery.element, ".wx-srv-gallery-tile")).toBe(firstTile);
    expect(q<HTMLImageElement>(firstTile, "img").getAttribute("src")).toBe("/t/2?new");
    expect(q<HTMLAnchorElement>(firstTile, ".wx-srv-gallery-save").getAttribute("href")).toBe("/d/2?new");
  });
});
