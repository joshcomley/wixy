// E2E for the Server chat gallery (workspace 00046): the ⋯ menu's Gallery, real thumbnails for a
// photo and a video, the pop-up viewer, per-item downloads, and "Download Any Undownloaded" with
// its per-device memory — on a desktop and a 360px phone viewport.

import { expect, test } from "../fixtures";
import type { Download, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const MULTI_TAP_INTERVAL_MS = 400;
const PHOTO = fileURLToPath(new URL("../fixtures/livechat-photo-gps.jpg", import.meta.url));
const SECOND_PHOTO = fileURLToPath(new URL("../fixtures/tiny-second-image.jpg", import.meta.url));
const VIDEO = fileURLToPath(new URL("../fixtures/livechat-video.mp4", import.meta.url));
const FILENAME = /^wixy-\d{8}-\d{6}-[0-9a-f]{8}\.(jpg|png|mp4)$/;

test.describe.configure({ timeout: 90_000 });

async function openPinPad(page: Page): Promise<void> {
  const configResponse = await page.request.post("/test/server/config");
  const { pin } = (await configResponse.json()) as { pin: string };
  await page.locator(".wx-srv-panel").click();
  await expect(page.locator(".wx-srv-affordance")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
  await page.locator(".wx-srv-affordance").click();
  await expect(page.locator(".wx-srv-pinpad")).toBeVisible();
  for (const digit of pin) {
    await page.locator(`.wx-srv-pinpad-key-digit:text-is("${digit}")`).click();
  }
  await page.locator(".wx-srv-pinpad-key-submit").click();
}

async function unlockServer(page: Page, name: string): Promise<void> {
  await page.goto("/admin/server");
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  await openPinPad(page);
  await expect(page.locator(".wx-srv-name-prompt")).toBeVisible();
  await page.locator(".wx-srv-name-prompt-input").fill(name);
  await page.locator(".wx-srv-name-prompt-button").click();
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

async function unlockAgain(page: Page): Promise<void> {
  await page.goto("/admin/server");
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  await openPinPad(page);
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

/** Attach the files, wait for every upload to finish, send. */
async function sendMedia(page: Page, files: string[]): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(files);
  const chips = page.locator(".wx-chat-attachment-chip");
  const send = page.locator(".wx-chat-send-button");
  await expect(chips).toHaveCount(files.length);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await send.isEnabled()) break;
    await page.mouse.move(24 + attempt, 24 + attempt);
    await page.waitForTimeout(250);
  }
  await expect(send).toBeEnabled();
  await send.click();
  await expect(chips).toHaveCount(0);
  // Two quick taps are the lock gesture; a test driving the page at machine speed must pause.
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

/** The queue (ffmpeg for video) finishes asynchronously; the gallery only lists `ready` media.
 * Specs in this file share one chat, so a later one passes `atLeast` instead of an exact count. */
async function openGalleryWhenReady(
  page: Page,
  expectedTiles: number,
  atLeast = false,
): Promise<void> {
  const tiles = page.locator(".wx-srv-gallery-tile");
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await page.locator(".wx-srv-more-button").click();
    await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
    await page.locator(".wx-srv-more-gallery").click();
    try {
      if (atLeast) {
        await expect.poll(() => tiles.count(), { timeout: 1_500 }).toBeGreaterThanOrEqual(expectedTiles);
      } else {
        await expect(tiles).toHaveCount(expectedTiles, { timeout: 1_500 });
      }
      await pace(page);
      return;
    } catch {
      await page.locator(".wx-srv-gallery-close").click();
      await pace(page);
    }
  }
  await expect(tiles).toHaveCount(expectedTiles);
}

/** Two taps within 400ms are the lock gesture (three, for controls marked as boundaries): a test
 * driving the page at machine speed must pause between taps like a person does. */
async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

async function allThumbnailsLoaded(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".wx-srv-gallery-thumb"));
    await Promise.all(images.map((img) => (img.complete ? null : img.decode().catch(() => null))));
    return images.map((img) => Math.max(img.naturalWidth, img.naturalHeight));
  });
}

test.describe("server-gallery.spec.ts", () => {
  test("desktop: thumbnails, viewer, downloads, and the per-device 'only the new ones'", async ({ page }) => {
    await unlockServer(page, "Gallery tester");
    await sendMedia(page, [PHOTO, VIDEO]);
    await openGalleryWhenReady(page, 2);

    // Real, small thumbnails for both the photo and the video (480px long edge at most).
    const sizes = await allThumbnailsLoaded(page);
    expect(sizes).toHaveLength(2);
    for (const size of sizes) {
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThanOrEqual(480);
    }
    await expect(page.locator(".wx-srv-gallery-badge")).toHaveCount(1);
    await expect(page.locator(".wx-srv-gallery-count")).toHaveText("2");

    // Tap the photo: a pop-up with the full picture.
    await page.locator(".wx-srv-gallery-tile").nth(1).locator(".wx-srv-gallery-open").click();
    const viewer = page.locator(".wx-srv-gallery-viewer");
    await expect(viewer).toBeVisible();
    await expect(viewer.locator("img.wx-srv-gallery-media")).toBeVisible();
    await expect
      .poll(() => viewer.locator("img.wx-srv-gallery-media").evaluate((n) => (n as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await expect(viewer.locator(".wx-srv-gallery-position")).toHaveText("2 / 2");
    // ...step to the video: a real player.
    await pace(page);
    await viewer.locator(".wx-srv-gallery-prev").click();
    const player = viewer.locator("video.wx-srv-gallery-media");
    await expect(player).toBeVisible();
    await player.evaluate((node) => {
      const element = node as HTMLVideoElement;
      element.muted = true;
      return element.play();
    });
    await expect
      .poll(() => player.evaluate((node) => (node as HTMLVideoElement).readyState))
      .toBeGreaterThanOrEqual(2);
    await pace(page);
    await viewer.locator(".wx-srv-gallery-viewer-close").click();
    await expect(viewer).toHaveCount(0);
    await pace(page);

    // A tile's own Download link saves the original under a clean name.
    const single = page.waitForEvent("download");
    await page.locator(".wx-srv-gallery-tile").nth(1).locator(".wx-srv-gallery-save").click();
    expect((await single).suggestedFilename()).toMatch(FILENAME);
    await pace(page);

    // Download Any Undownloaded: both, oldest first (photo was sent with the video, in order).
    const downloadAll = page.locator(".wx-srv-gallery-download-all");
    await expect(downloadAll).toHaveText("Download Any Undownloaded (2)");
    const seen: Download[] = [];
    page.on("download", (download) => seen.push(download));
    await downloadAll.click();
    await expect.poll(() => seen.length, { timeout: 30_000 }).toBe(2);
    expect(seen.map((d) => d.suggestedFilename().split(".").pop())).toEqual(["jpg", "mp4"]);
    for (const download of seen) expect(download.suggestedFilename()).toMatch(FILENAME);
    await expect(downloadAll).toBeDisabled();
    await expect(page.locator(".wx-srv-gallery-status")).toHaveText("Downloaded 2 files.");

    // A few "days" later (a reload): remembered on this device, nothing is offered again...
    await pace(page);
    await page.locator(".wx-srv-gallery-close").click();
    await page.reload();
    await unlockAgain(page);
    await openGalleryWhenReady(page, 2);
    await expect(page.locator(".wx-srv-gallery-download-all")).toBeDisabled();
    await expect(page.locator(".wx-srv-gallery-status")).toHaveText(
      "Everything is already downloaded on this device.",
    );

    // ...until something new is sent: then it offers, and fetches, exactly that.
    await pace(page);
    await page.locator(".wx-srv-gallery-close").click();
    await pace(page);
    await sendMedia(page, [SECOND_PHOTO]);
    await openGalleryWhenReady(page, 3);
    const fresh = page.locator(".wx-srv-gallery-download-all");
    await expect(fresh).toHaveText("Download Any Undownloaded (1)");
    seen.length = 0;
    await fresh.click();
    await expect.poll(() => seen.length, { timeout: 30_000 }).toBe(1);
    await expect(fresh).toBeDisabled();
    await page.waitForTimeout(1_500);
    expect(seen).toHaveLength(1);
  });

  test("phone (360px): a three-column grid with no sideways scroll, and a usable viewer", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 740 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await unlockServer(page, "Phone gallery");
    await sendMedia(page, [PHOTO, VIDEO]);
    await openGalleryWhenReady(page, 2, true);
    await allThumbnailsLoaded(page);

    const layout = await page.evaluate(() => {
      const view = document.querySelector<HTMLElement>(".wx-srv-gallery-view")!;
      const tiles = Array.from(document.querySelectorAll<HTMLElement>(".wx-srv-gallery-tile"));
      const rects = tiles.map((t) => t.getBoundingClientRect());
      const header = document.querySelector<HTMLElement>(".wx-srv-thread-header")!.getBoundingClientRect();
      return {
        overflowX: view.scrollWidth - view.clientWidth,
        pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        viewTop: view.getBoundingClientRect().top,
        headerBottom: header.bottom,
        firstRow: rects.filter((r) => Math.abs(r.top - rects[0]!.top) < 2).length,
        tiles: rects.length,
        tileWidth: rects[0]?.width ?? 0,
        saveHeight: document.querySelector<HTMLElement>(".wx-srv-gallery-save")!.getBoundingClientRect().height,
        buttonHeight: document.querySelector<HTMLElement>(".wx-srv-gallery-download-all")!.getBoundingClientRect().height,
      };
    });
    expect(layout.overflowX).toBeLessThanOrEqual(0);
    expect(layout.pageOverflowX).toBeLessThanOrEqual(0);
    // The gallery sits under the header, so the panic ✕ stays reachable.
    expect(Math.abs(layout.viewTop - layout.headerBottom)).toBeLessThan(2);
    expect(layout.firstRow).toBe(Math.min(3, layout.tiles));
    expect(layout.tileWidth).toBeGreaterThan(90);
    expect(layout.buttonHeight).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: "test-results/gallery-phone.png" });

    await pace(page);
    await page.locator(".wx-srv-gallery-open").first().tap();
    const viewer = page.locator(".wx-srv-gallery-viewer");
    await expect(viewer).toBeVisible();
    const box = (await viewer.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(360);
    await page.screenshot({ path: "test-results/gallery-phone-viewer.png" });
    await pace(page);
    await viewer.locator(".wx-srv-gallery-viewer-close").tap();
    await expect(viewer).toHaveCount(0);
    await pace(page);

    // The panic ✕ still closes the whole chat from inside the gallery.
    await page.locator('.wx-srv-chat-host button[aria-label="Close"]').tap();
    await expect(page.locator(".wx-srv-thread")).toHaveCount(0);
    await context.close();
  });
});
