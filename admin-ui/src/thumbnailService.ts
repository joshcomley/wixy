// Page-thumbnail capture service (decisions/00078): renders each page's MOBILE
// preview in a hidden offscreen iframe, captures it to a JPEG, and PUTs it to
// the server, which serves it back to the Pages panel. Client-side by design:
// the admin already renders pages in iframes — a browser engine on the server
// would be a heavy deployment dependency (and the independence standalone
// target must stay free of one). html2canvas walks the same-origin iframe's
// DOM and paints it into a canvas; overlay editing chrome is excluded via
// `ignoreElements`, so a capture mid-edit stays clean.
//
// Serial, deduped, debounced: a burst of accepted ops (typing) coalesces into
// one capture per page after a quiet period; captures run one at a time so a
// phone never pays for two hidden iframes at once.

import html2canvas from "html2canvas";

export interface ThumbnailApi {
  putThumbnail: (slug: string, blob: Blob) => Promise<unknown>;
}

export interface ThumbnailService {
  /** Queue (re)captures for the given slugs (deduped, debounced per slug). */
  refresh: (slugs: string[]) => void;
  teardown: () => void;
}

export const THUMBNAIL_VIEWPORT = { width: 390, height: 780 } as const;
const SETTLE_MS = 900;
const DEBOUNCE_MS = 1500;
const JPEG_QUALITY = 0.75;

const OVERLAY_CHROME_SELECTOR =
  ".wx-if-eye-toggle, .wx-hover-chip, .wx-item-toolbar, .wx-popover, .wx-composer, .wx-toast";

async function capturePage(slug: string, win: Window): Promise<Blob> {
  const iframe = win.document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.left = "-10000px";
  iframe.style.top = "0";
  iframe.style.width = `${THUMBNAIL_VIEWPORT.width}px`;
  iframe.style.height = `${THUMBNAIL_VIEWPORT.height}px`;
  iframe.style.border = "0";
  iframe.style.pointerEvents = "none";
  win.document.body.appendChild(iframe);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = win.setTimeout(() => reject(new Error("preview load timeout")), 15_000);
      iframe.addEventListener("load", () => {
        win.clearTimeout(timer);
        resolve();
      });
      iframe.src = `/admin/preview/${slug}.html`;
    });
    // Fonts/images settle — a bare load event fires before webfonts finish.
    await new Promise((resolve) => win.setTimeout(resolve, SETTLE_MS));
    const doc = iframe.contentDocument;
    if (doc === null || doc.body === null) throw new Error("preview document unavailable");
    const canvas = await html2canvas(doc.body, {
      windowWidth: THUMBNAIL_VIEWPORT.width,
      ignoreElements: (el) => el.matches(OVERLAY_CHROME_SELECTOR),
      // html2canvas console.errors every undecodable image (e.g. the e2e
      // fixture's fake-jpeg bytes) — non-actionable for a best-effort
      // thumbnail, and they trip the suite's console-error tripwire.
      logging: false,
    } as Parameters<typeof html2canvas>[1]);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob === null ? reject(new Error("canvas encode failed")) : resolve(blob)),
        "image/jpeg",
        JPEG_QUALITY,
      );
    });
  } finally {
    iframe.remove();
  }
}

export function createThumbnailService(opts: {
  api: ThumbnailApi;
  win?: Window;
  /** Injectable for tests (no real html2canvas/jsdom canvas). */
  capture?: (slug: string, win: Window) => Promise<Blob>;
  /** A capture landed on the server — the caller (shell) re-renders the
   * Pages panel if it's mounted so placeholders swap to real thumbnails
   * in real time (otherwise they'd wait for the 60s revalidation). */
  onCaptured?: (slug: string) => void;
}): ThumbnailService {
  const win = opts.win ?? window;
  const capture = opts.capture ?? capturePage;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const queue: string[] = [];
  let running = false;

  async function drain(): Promise<void> {
    if (running) return;
    const slug = queue.shift();
    if (slug === undefined) return;
    running = true;
    try {
      const blob = await capture(slug, win);
      await opts.api.putThumbnail(slug, blob);
      opts.onCaptured?.(slug);
    } catch {
      // A failed capture leaves the placeholder in place — the next trigger
      // re-queues it. Never let one bad page stall the queue.
    } finally {
      running = false;
      void drain();
    }
  }

  return {
    refresh(slugs: string[]): void {
      for (const slug of slugs) {
        const existing = pending.get(slug);
        if (existing !== undefined) clearTimeout(existing);
        pending.set(
          slug,
          setTimeout(() => {
            pending.delete(slug);
            if (!queue.includes(slug)) queue.push(slug);
            void drain();
          }, DEBOUNCE_MS),
        );
      }
    },
    teardown(): void {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      queue.length = 0;
    },
  };
}
