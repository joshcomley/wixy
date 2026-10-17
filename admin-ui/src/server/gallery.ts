// The Server chat gallery (workspace 00046): the "Gallery" entry in the ⋯ menu opens this
// full-height screen over the thread, showing every photo and video ever sent as a grid of
// small thumbnails.
//
//   - Tap a tile: a pop-up viewer — the picture, or the video with its player — with previous /
//     next and a save link.
//   - Every tile has its own Download link.
//   - "Download Any Undownloaded" saves everything not yet saved ON THIS DEVICE, oldest first,
//     one file at a time, and remembers where it got to (`galleryMark.ts`) so a later tap only
//     fetches what was sent since.
//
// Lock behaviour is the thread's: `close()` is called by `thread.detach()`, which stops a run in
// progress, tears down the viewer's video and drops every signed URL. View-once media never
// reaches this screen (the server leaves it out).

import { formatDuration, wireMediaSuspension } from "./mediaRender";
import {
  GALLERY_FIRST_PAGE,
  GALLERY_PAGE,
  getGalleryPage,
  type GalleryCursor,
  type GalleryItem,
  type GalleryPage,
} from "./api/gallery";
import { ServerLockedError } from "./api/http";
import { isAfterMark, type DownloadMarkStore } from "./galleryMark";
import type { LockHooks, ServerSession } from "./types";

export interface GalleryDeps {
  readonly document: Document;
  readonly win: Window;
  readonly hooks: Pick<LockHooks, "suspend" | "lockNow">;
  readonly getSession: () => ServerSession | null;
  readonly mark: DownloadMarkStore;
  /** Injectable for tests; defaults to the real `GET /gallery`. */
  readonly fetchPage?: (
    session: ServerSession,
    opts: { before?: GalleryCursor; limit?: number },
  ) => Promise<GalleryPage>;
  /** Fetches a media file for "Download Any Undownloaded"; defaults to the window's `fetch`. */
  readonly fetch?: typeof fetch;
  /** Pause between saved files — browsers want a beat between programmatic downloads. */
  readonly downloadGapMs?: number;
  readonly now?: () => number;
}

export interface GalleryView {
  readonly element: HTMLElement;
  /** Show the gallery below `topOffsetPx` (the chat header's height). */
  open(topOffsetPx: number): void;
  close(): void;
  isOpen(): boolean;
  /** A renewed session: re-mint every signed URL in place, with no visible change. */
  refreshSession(): void;
}

const DEFAULT_GAP_MS = 500;

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Every control here is a gesture boundary (gestures.ts): flicking through photos or tapping a
 * run of Download links must not read as the double-tap that locks the chat — a boundary chain
 * needs a third rapid tap. Same treatment as the lightbox and the message action sheet. */
function boundary<T extends HTMLElement>(node: T): T {
  node.setAttribute("data-srv-gesture-boundary", "");
  return node;
}

function button(doc: Document, className: string, label: string, text: string): HTMLButtonElement {
  const b = el(doc, "button", className, text);
  b.type = "button";
  b.setAttribute("aria-label", label);
  return boundary(b);
}

function thumbUrlOf(item: GalleryItem): string | undefined {
  return item.urls.thumb ?? item.urls.poster ?? (item.kind === "photo" ? item.urls.full : undefined);
}

function dateLabel(item: GalleryItem): string {
  if (item.createdAt <= 0) return "";
  try {
    return new Date(item.createdAt * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  } catch {
    return "";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "Something went wrong.";
}

export function createGallery(deps: GalleryDeps): GalleryView {
  const { document: doc, win, hooks } = deps;
  const fetchPage = deps.fetchPage ?? getGalleryPage;
  const fetchFile: typeof fetch = deps.fetch ?? ((input, init) => win.fetch(input, init));
  const gapMs = deps.downloadGapMs ?? DEFAULT_GAP_MS;
  const now = deps.now ?? (() => Date.now());

  // -- Static structure -----------------------------------------------------------------

  const root = el(doc, "div", "wx-srv-gallery-view");
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Gallery");

  const bar = el(doc, "div", "wx-srv-gallery-bar");
  const title = el(doc, "span", "wx-srv-gallery-title", "Gallery");
  const count = el(doc, "span", "wx-srv-gallery-count");
  const closeButton = button(doc, "wx-srv-gallery-close", "Back to chat", "Back to chat");
  bar.append(title, count, closeButton);

  const actions = el(doc, "div", "wx-srv-gallery-actions");
  const downloadAll = button(
    doc,
    "wx-srv-gallery-download-all",
    "Download Any Undownloaded",
    "Download Any Undownloaded",
  );
  downloadAll.disabled = true;
  const cancelRun = button(doc, "wx-srv-gallery-cancel", "Stop downloading", "Stop");
  cancelRun.hidden = true;
  const status = el(doc, "p", "wx-srv-gallery-status");
  status.setAttribute("role", "status");
  actions.append(downloadAll, cancelRun, status);

  const scroller = el(doc, "div", "wx-srv-gallery-scroll");
  const grid = el(doc, "div", "wx-srv-gallery-grid");
  const empty = el(doc, "p", "wx-srv-gallery-empty", "No photos or videos yet.");
  empty.hidden = true;
  const loadError = el(doc, "p", "wx-srv-gallery-error");
  loadError.hidden = true;
  const retry = button(doc, "wx-srv-gallery-retry", "Try loading the gallery again", "Try again");
  retry.hidden = true;
  scroller.append(grid, empty, loadError, retry);

  root.append(bar, actions, scroller);

  // -- State ----------------------------------------------------------------------------

  /** Newest first, exactly as the server sent them. */
  let items: GalleryItem[] = [];
  let hasMore = false;
  let fullyLoaded = false;
  let opened = false;
  /** Bumped on every open/close so a response from a previous session of the screen is dropped. */
  let generation = 0;
  let viewer: ViewerHandle | null = null;
  let run: { readonly abort: AbortController; readonly release: () => void } | null = null;
  const tiles = new Map<string, { readonly thumb: HTMLImageElement; readonly save: HTMLAnchorElement }>();

  // -- Rendering --------------------------------------------------------------------------

  function setStatus(text: string): void {
    status.textContent = text;
    status.hidden = text === "";
  }

  function pendingItems(): GalleryItem[] {
    const mark = deps.mark.read();
    return items
      .filter((item) => item.downloadUrl !== null && isAfterMark(item, mark))
      .reverse(); // oldest first
  }

  function refreshActions(): void {
    count.textContent = items.length === 0 ? "" : `${items.length}${hasMore ? "+" : ""}`;
    empty.hidden = !(fullyLoaded && items.length === 0);
    if (run !== null) return;
    if (!fullyLoaded) {
      downloadAll.disabled = true;
      downloadAll.textContent = "Download Any Undownloaded";
      return;
    }
    const pending = pendingItems().length;
    downloadAll.disabled = pending === 0;
    downloadAll.textContent = pending === 0 ? "Download Any Undownloaded" : `Download Any Undownloaded (${pending})`;
    if (status.textContent === "") {
      const last = deps.mark.read();
      if (pending === 0 && items.length > 0) {
        setStatus("Everything is already downloaded on this device.");
      } else if (last !== null) {
        setStatus(`Last downloaded ${new Date(last.at).toLocaleDateString()}.`);
      }
    }
  }

  function applyUrls(item: GalleryItem): void {
    const tile = tiles.get(item.id);
    if (tile === undefined) return;
    const src = thumbUrlOf(item);
    if (src !== undefined) tile.thumb.src = src;
    if (item.downloadUrl !== null) tile.save.href = item.downloadUrl;
  }

  function renderTile(item: GalleryItem): HTMLElement {
    const tile = el(doc, "div", "wx-srv-gallery-tile");
    tile.dataset["id"] = item.id;
    const open = button(
      doc,
      "wx-srv-gallery-open",
      item.kind === "video" ? "Play video" : "View photo",
      "",
    );
    const thumb = doc.createElement("img");
    thumb.className = "wx-srv-gallery-thumb";
    thumb.alt = "";
    thumb.loading = "lazy";
    thumb.decoding = "async";
    open.appendChild(thumb);
    if (item.kind === "video") {
      const badge = el(doc, "span", "wx-srv-gallery-badge");
      badge.textContent = item.durationS !== null ? `▶ ${formatDuration(item.durationS)}` : "▶";
      open.appendChild(badge);
    }
    open.addEventListener("click", () => openViewer(item.id));

    const foot = el(doc, "div", "wx-srv-gallery-foot");
    foot.appendChild(el(doc, "span", "wx-srv-gallery-date", dateLabel(item)));
    const save = boundary(doc.createElement("a"));
    save.className = "wx-srv-gallery-save";
    save.textContent = "Download";
    save.setAttribute("download", item.filename);
    save.setAttribute("aria-label", `Download ${item.kind}`);
    save.rel = "noopener";
    if (item.downloadUrl === null) save.hidden = true;
    foot.appendChild(save);

    tile.append(open, foot);
    tiles.set(item.id, { thumb, save });
    applyUrls(item);
    return tile;
  }

  function appendItems(page: readonly GalleryItem[]): void {
    const have = new Set(items.map((i) => i.id));
    const fresh = page.filter((i) => !have.has(i.id));
    items = items.concat(fresh);
    for (const item of fresh) grid.appendChild(renderTile(item));
  }

  // -- Loading ----------------------------------------------------------------------------

  function lockOrShow(error: unknown): void {
    if (error instanceof ServerLockedError) {
      hooks.lockNow("unauthorized");
      return;
    }
    loadError.textContent = errorText(error);
    loadError.hidden = false;
    retry.hidden = false;
  }

  /** The first screenful at once, then the rest of the history in the background — metadata
   * only (the thumbnails load lazily), so "Download Any Undownloaded" can count what is new. */
  async function loadAll(startGeneration: number): Promise<void> {
    loadError.hidden = true;
    retry.hidden = true;
    try {
      while (generation === startGeneration) {
        const session = deps.getSession();
        if (session === null) return;
        const last = items[items.length - 1];
        const page = await fetchPage(session, {
          ...(last !== undefined ? { before: { seq: last.seq, ordinal: last.ordinal } } : {}),
          limit: items.length === 0 ? GALLERY_FIRST_PAGE : GALLERY_PAGE,
        });
        if (generation !== startGeneration) return;
        appendItems(page.items);
        hasMore = page.hasMore && page.items.length > 0;
        if (!hasMore) {
          fullyLoaded = true;
        }
        refreshActions();
        if (!hasMore) return;
      }
    } catch (error) {
      if (generation !== startGeneration) return;
      lockOrShow(error);
    }
  }

  retry.addEventListener("click", () => void loadAll(generation));

  /** After a session renewal: ask for the same pages again and swap in the fresh URLs. */
  async function refreshUrls(startGeneration: number): Promise<void> {
    try {
      let before: GalleryCursor | undefined;
      let remaining = items.length;
      while (remaining > 0 && generation === startGeneration) {
        const session = deps.getSession();
        if (session === null) return;
        const page = await fetchPage(session, {
          ...(before !== undefined ? { before } : {}),
          limit: Math.min(GALLERY_PAGE, remaining),
        });
        if (generation !== startGeneration) return;
        for (const fresh of page.items) {
          const index = items.findIndex((i) => i.id === fresh.id);
          if (index !== -1) {
            items[index] = fresh;
            applyUrls(fresh);
          }
        }
        viewer?.refresh();
        remaining -= page.items.length;
        const tail = page.items[page.items.length - 1];
        if (!page.hasMore || tail === undefined) return;
        before = { seq: tail.seq, ordinal: tail.ordinal };
      }
    } catch (error) {
      if (error instanceof ServerLockedError) hooks.lockNow("unauthorized");
      // Any other failure: the old URLs keep working until their own expiry; nothing to show.
    }
  }

  // -- Viewer -----------------------------------------------------------------------------

  interface ViewerHandle {
    refresh(): void;
    close(): void;
  }

  function openViewer(id: string): void {
    closeViewer();
    let index = items.findIndex((i) => i.id === id);
    if (index === -1) return;

    const overlay = el(doc, "div", "wx-srv-gallery-viewer");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Media viewer");
    const stage = el(doc, "div", "wx-srv-gallery-stage");
    const top = el(doc, "div", "wx-srv-gallery-viewer-bar");
    const position = el(doc, "span", "wx-srv-gallery-position");
    const save = boundary(doc.createElement("a"));
    save.className = "wx-srv-gallery-viewer-save";
    save.textContent = "Download";
    save.rel = "noopener";
    const close = button(doc, "wx-srv-gallery-viewer-close", "Close viewer", "✕");
    top.append(position, save, close);
    const prev = button(doc, "wx-srv-gallery-prev", "Previous", "‹");
    const next = button(doc, "wx-srv-gallery-next", "Next", "›");
    overlay.append(stage, top, prev, next);

    function releaseStage(): void {
      for (const video of stage.querySelectorAll("video")) {
        try {
          video.pause();
        } catch {
          // Nothing to pause on a detached element.
        }
        video.removeAttribute("src");
        video.removeAttribute("poster");
        try {
          video.load();
        } catch {
          // Older engines may not implement load() on a detached node.
        }
      }
      stage.replaceChildren();
    }

    function show(): void {
      const item = items[index];
      if (item === undefined) return;
      releaseStage();
      position.textContent = `${index + 1} / ${items.length}${hasMore ? "+" : ""}`;
      if (item.kind === "video" && item.urls.play !== undefined) {
        const video = doc.createElement("video");
        video.className = "wx-srv-gallery-media";
        video.controls = true;
        video.playsInline = true;
        video.preload = "metadata";
        if (item.urls.poster !== undefined) video.poster = item.urls.poster;
        video.src = item.urls.play;
        wireMediaSuspension(video, hooks);
        stage.appendChild(video);
      } else {
        const picture = doc.createElement("img");
        picture.className = "wx-srv-gallery-media";
        picture.alt = "";
        const src = item.urls.full ?? thumbUrlOf(item);
        if (src !== undefined) picture.src = src;
        stage.appendChild(picture);
      }
      if (item.downloadUrl !== null) {
        save.href = item.downloadUrl;
        save.setAttribute("download", item.filename);
        save.hidden = false;
      } else {
        save.hidden = true;
      }
      prev.disabled = index <= 0;
      next.disabled = index >= items.length - 1;
    }

    function step(delta: number): void {
      const target = index + delta;
      if (target < 0 || target >= items.length) return;
      index = target;
      show();
    }

    prev.addEventListener("click", () => step(-1));
    next.addEventListener("click", () => step(1));
    close.addEventListener("click", closeViewer);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay || event.target === stage) closeViewer();
    });
    root.appendChild(overlay);
    show();
    close.focus();

    viewer = {
      refresh(): void {
        // Only the save link is re-pointed: the picture or video on screen keeps playing from
        // the URL it started with (reloading it would restart playback).
        const item = items[index];
        if (item?.downloadUrl != null) save.href = item.downloadUrl;
      },
      close(): void {
        releaseStage();
        overlay.remove();
      },
    };
  }

  function closeViewer(): void {
    viewer?.close();
    viewer = null;
  }

  // -- Download Any Undownloaded ----------------------------------------------------------

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = win.setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          win.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  /** Hand one fully-received file to the browser's own save mechanism. */
  function saveBlob(blob: Blob, filename: string): void {
    const objectUrl = URL.createObjectURL(blob);
    const link = doc.createElement("a");
    link.href = objectUrl;
    link.setAttribute("download", filename);
    link.hidden = true;
    root.appendChild(link);
    link.click();
    link.remove();
    // Long enough for the browser to have started reading it, however slow the device.
    win.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }

  async function downloadUndownloaded(): Promise<void> {
    if (run !== null || !fullyLoaded) return;
    const pending = pendingItems();
    if (pending.length === 0) {
      refreshActions();
      return;
    }
    const abort = new AbortController();
    // A long run must not be cut short by the idle auto-lock mid-file; every other lock trigger
    // (panic, backgrounding, the screen locking) still stops it.
    const release = hooks.suspend("mediaPlaying");
    run = { abort, release };
    downloadAll.disabled = true;
    cancelRun.hidden = false;
    let done = 0;
    let failure: string | null = null;
    try {
      for (const item of pending) {
        if (abort.signal.aborted) break;
        if (item.downloadUrl === null) continue;
        setStatus(`Downloading ${done + 1} of ${pending.length}…`);
        try {
          const response = await fetchFile(item.downloadUrl, { signal: abort.signal });
          if (!response.ok) throw new Error(`The server said ${response.status}.`);
          const blob = await response.blob();
          if (abort.signal.aborted) break;
          saveBlob(blob, item.filename);
        } catch (error) {
          if (abort.signal.aborted) break;
          failure = `Stopped after ${done} of ${pending.length}: couldn't fetch ${item.filename} (${errorText(error)}) Tap again to carry on.`;
          break;
        }
        // Moved only now the file has fully arrived: an interrupted run resumes at the next one.
        deps.mark.write({ seq: item.seq, ordinal: item.ordinal, at: now() });
        done += 1;
        await sleep(gapMs, abort.signal);
      }
    } finally {
      run?.release();
      run = null;
      cancelRun.hidden = true;
    }
    const stopped = abort.signal.aborted;
    setStatus(
      failure ??
        (stopped
          ? `Stopped after ${done} of ${pending.length}. Tap again to carry on.`
          : `Downloaded ${done} ${done === 1 ? "file" : "files"}.`),
    );
    refreshActions();
  }

  downloadAll.addEventListener("click", () => void downloadUndownloaded());
  cancelRun.addEventListener("click", () => run?.abort.abort());
  closeButton.addEventListener("click", () => view.close());

  // -- Public ---------------------------------------------------------------------------------

  const view: GalleryView = {
    element: root,
    open(topOffsetPx: number): void {
      if (opened) return;
      opened = true;
      generation += 1;
      items = [];
      hasMore = false;
      fullyLoaded = false;
      tiles.clear();
      grid.replaceChildren();
      setStatus("");
      root.style.top = `${topOffsetPx}px`;
      root.hidden = false;
      refreshActions();
      void loadAll(generation);
    },
    close(): void {
      if (!opened) return;
      opened = false;
      generation += 1;
      run?.abort.abort();
      closeViewer();
      root.hidden = true;
      grid.replaceChildren();
      tiles.clear();
      items = [];
      setStatus("");
    },
    isOpen(): boolean {
      return opened;
    },
    refreshSession(): void {
      if (opened && items.length > 0) void refreshUrls(generation);
    },
  };
  return view;
}
