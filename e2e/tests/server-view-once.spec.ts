// E2E for view-once photos/videos and the spotlight reveal (spec/server-chat/06-view-once-media.md).
// Verifies two identities, desktop and mobile viewports, automatic disappearance after display,
// recipient vs sender cards, 409 already-opened race, and spotlight slider interaction.

import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const MULTI_TAP_INTERVAL_MS = 400;
const PHOTO = fileURLToPath(new URL("../fixtures/livechat-photo-gps.jpg", import.meta.url));

async function unlockServer(page: Page, name: string): Promise<void> {
  const configResponse = await page.request.post("/test/server/config");
  const { pin } = (await configResponse.json()) as { pin: string };

  await page.goto("/admin/server");
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  await expect(page.locator(".wx-srv-affordance")).toBeHidden();

  await page.locator(".wx-srv-panel").click();
  await expect(page.locator(".wx-srv-affordance")).toBeVisible();
  await page.waitForTimeout(500);
  await page.locator(".wx-srv-affordance").click();
  await expect(page.locator(".wx-srv-pinpad")).toBeVisible();

  for (const digit of pin) {
    await page.locator(`.wx-srv-pinpad-key-digit:text-is("${digit}")`).click();
  }
  await page.locator(".wx-srv-pinpad-key-submit").click();

  const namePrompt = page.locator(".wx-srv-name-prompt");
  await expect(page.locator(".wx-srv-name-prompt:visible, .wx-srv-thread:visible")).toBeVisible({
    timeout: 5000,
  });
  if (await namePrompt.isVisible()) {
    await expect(page.locator(".wx-srv-thread-view")).toBeHidden();
    await page.locator(".wx-srv-name-prompt-input").fill(name);
    await page.locator(".wx-srv-name-prompt-button").click();
  }
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await expect(page.locator(".wx-srv-name-prompt")).toBeHidden();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

test.describe("server-view-once.spec.ts (spec/06-view-once-media)", () => {
  test("desktop: 2s view-once photo opens, closes by itself, vanishes on both sides, sender has no Tap to view", async ({
    browser,
  }) => {
    const contextAlice = await browser.newContext({
      extraHTTPHeaders: { "CF-Access-Authenticated-User-Email": "alice@example.com" },
    });
    const contextBob = await browser.newContext({
      extraHTTPHeaders: { "CF-Access-Authenticated-User-Email": "bob@example.com" },
    });

    const pageAlice = await contextAlice.newPage();
    const pageBob = await contextBob.newPage();

    await unlockServer(pageAlice, "Alice");
    await unlockServer(pageBob, "Bob");

    // Alice uploads photo via fixture helper (simulating normal upload route)
    const uploadRes = await pageAlice.request.post("/test/server/upload-photo");
    const { attachmentId } = (await uploadRes.json()) as { attachmentId: string };

    // Get Alice's unlock token to send through the real POST /api/admin/server/messages/view-once route
    const configRes = await pageAlice.request.post("/test/server/config");
    const { pin } = (await configRes.json()) as { pin: string };
    const unlockRes = await pageAlice.request.post("/api/admin/server/unlock", {
      headers: { "X-Wixy-Server-Unlock": "1", "Content-Type": "application/json" },
      data: { pin },
    });
    const { token: aliceToken } = (await unlockRes.json()) as { token: string };

    const sendRes = await pageAlice.request.post("/api/admin/server/messages/view-once", {
      headers: {
        "X-Wixy-Server-Unlock": "1",
        "X-Wixy-Server-Token": aliceToken,
        "Content-Type": "application/json",
      },
      data: {
        clientId: `client-e2e-${Date.now()}`,
        sender: "Alice",
        deviceId: "device-alice-e2e",
        attachmentId,
        durationS: 2,
        spotlight: false,
      },
    });
    expect(sendRes.status()).toBe(201);
    const { message } = (await sendRes.json()) as { message: { seq: number } };
    const seq = message.seq;

    // Alice sees sender card with "Not opened yet" and NO "Tap to view" button
    const aliceBubble = pageAlice.locator(`[data-message-seq="${seq}"]`);
    await expect(aliceBubble).toBeVisible({ timeout: 5000 });
    await expect(aliceBubble.locator(".wx-srv-view-once-sender-card")).toBeVisible();
    await expect(aliceBubble.locator(".wx-srv-view-once-sender-card")).toContainText("Not opened yet");
    await expect(aliceBubble.locator(".wx-srv-view-once-tap-btn")).toHaveCount(0);

    // Bob sees recipient card with "Tap to view" button
    const bobBubble = pageBob.locator(`[data-message-seq="${seq}"]`);
    await expect(bobBubble).toBeVisible({ timeout: 5000 });
    const tapBtn = bobBubble.locator(".wx-srv-view-once-tap-btn");
    await expect(tapBtn).toBeVisible();
    await expect(tapBtn).toContainText("Tap to view");

    // Bob opens the view-once photo
    await tapBtn.click();

    // Bob sees full-screen overlay with canvas
    const overlay = pageBob.locator(".wx-srv-view-once-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay.locator("canvas")).toBeVisible();
    await expect(overlay.locator(".wx-srv-view-once-ring-wrap")).toBeVisible();

    // After 2s, the overlay closes by itself
    await expect(overlay).toBeHidden({ timeout: 6000 });

    // The message is deleted and vanishes from both sides
    await expect(bobBubble).toBeHidden({ timeout: 5000 });
    await expect(aliceBubble).toBeHidden({ timeout: 5000 });

    await contextAlice.close();
    await contextBob.close();
  });

  test("a second tab of the recipient gets 'Already opened' (409)", async ({ browser }) => {
    const contextAlice = await browser.newContext({
      extraHTTPHeaders: { "CF-Access-Authenticated-User-Email": "alice@example.com" },
    });
    const contextBob = await browser.newContext({
      extraHTTPHeaders: { "CF-Access-Authenticated-User-Email": "bob@example.com" },
    });

    const pageAlice = await contextAlice.newPage();
    const pageBob1 = await contextBob.newPage();

    await unlockServer(pageAlice, "Alice");
    await unlockServer(pageBob1, "Bob");

    // Seed a 30s view-once photo
    const seedRes = await pageAlice.request.post("/test/server/seed-photo", {
      data: {
        sender: "Alice",
        by_email: "alice@example.com",
        view_once_s: 30,
        spotlight: false,
      },
    });
    const { seq } = (await seedRes.json()) as { seq: number };

    // Bob's tab 2 unlocks server
    const pageBob2 = await contextBob.newPage();
    await unlockServer(pageBob2, "Bob");

    // Hold tab 1's content download so it stays claimed while tab 2 attempts to claim
    let releaseContent!: () => void;
    let contentReached!: () => void;
    const contentReachedPromise = new Promise<void>((r) => {
      contentReached = r;
    });
    const contentGate = new Promise<void>((r) => {
      releaseContent = r;
    });
    await pageBob1.route(/\/view-once\/content/, async (route) => {
      contentReached();
      await contentGate;
      await route.continue();
    });

    // Bob tab 1 taps to view (claims the item)
    const tapBtn1 = pageBob1.locator(`[data-message-seq="${seq}"] .wx-srv-view-once-tap-btn`);
    await expect(tapBtn1).toBeVisible({ timeout: 5000 });
    await tapBtn1.click();
    await contentReachedPromise;
    await expect(pageBob1.locator(".wx-srv-view-once-overlay")).toBeVisible();

    // Bob tab 2 also taps to view on the same message
    const tapBtn2 = pageBob2.locator(`[data-message-seq="${seq}"] .wx-srv-view-once-tap-btn`);
    await expect(tapBtn2).toBeVisible({ timeout: 5000 });
    await tapBtn2.click();

    // Bob tab 2 gets "Already opened" status message
    const overlay2 = pageBob2.locator(".wx-srv-view-once-overlay");
    await expect(overlay2).toBeVisible();
    await expect(overlay2.locator(".wx-srv-view-once-status")).toContainText("Already opened");

    // Release content gate so tab 1 finishes or closes cleanly
    releaseContent();

    // Close overlays
    await pageBob1.locator(".wx-srv-view-once-close").click();
    await pageBob2.locator(".wx-srv-view-once-close").click();

    await contextAlice.close();
    await contextBob.close();
  });

  test("mobile: spotlight photo renders cut-out and slider changes it", async ({ browser }) => {
    const contextAlice = await browser.newContext({
      extraHTTPHeaders: { "CF-Access-Authenticated-User-Email": "alice@example.com" },
    });
    const contextBobMobile = await browser.newContext({
      viewport: { width: 375, height: 667 },
      isMobile: true,
      hasTouch: true,
      extraHTTPHeaders: { "CF-Access-Authenticated-User-Email": "bob@example.com" },
    });

    const pageAlice = await contextAlice.newPage();
    const pageBob = await contextBobMobile.newPage();

    await unlockServer(pageAlice, "Alice");
    await unlockServer(pageBob, "Bob");

    // Seed a 30s spotlight photo
    const seedRes = await pageAlice.request.post("/test/server/seed-photo", {
      data: {
        sender: "Alice",
        by_email: "alice@example.com",
        view_once_s: 30,
        spotlight: true,
      },
    });
    const { seq } = (await seedRes.json()) as { seq: number };

    // Bob sees recipient bubble with Spotlight badge
    const bobBubble = pageBob.locator(`[data-message-seq="${seq}"]`);
    await expect(bobBubble).toBeVisible({ timeout: 5000 });
    await expect(bobBubble.locator(".wx-srv-view-once-spotlight-badge")).toContainText("Spotlight");

    // Bob taps to view
    await bobBubble.locator(".wx-srv-view-once-tap-btn").click();

    // Spotlight overlay renders canvas and slider
    const overlay = pageBob.locator(".wx-srv-view-once-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay.locator("canvas")).toBeVisible();

    const slider = overlay.locator(".wx-srv-view-once-slider");
    await expect(slider).toBeVisible();
    await expect(slider).toHaveAttribute("min", "6");
    await expect(slider).toHaveAttribute("max", "35");
    await expect(slider).toHaveValue("12");

    // Pin spotlight to center (187, 333) with pointerdown on canvas
    const canvas = overlay.locator("canvas");
    await canvas.dispatchEvent("pointerdown", { clientX: 187, clientY: 333 });

    // Sample pixels at slider = 12:
    // (a) Corner (10, 10) is solid black mask (outside hole)
    // (b) Center (187, 333) has image color (inside hole, blue: B > 100)
    // (c) Intermediate point at distance ~75px from center (262, 333):
    //     At slider = 12 (radius ~45px), it is outside hole (black mask)
    const initialSample = await pageBob.evaluate(() => {
      const cv = document.querySelector<HTMLCanvasElement>(".wx-srv-view-once-overlay canvas");
      if (!cv) return null;
      const ctx = cv.getContext("2d");
      if (!ctx) return null;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const corner = ctx.getImageData(Math.round(10 * dpr), Math.round(10 * dpr), 1, 1).data;
      const center = ctx.getImageData(Math.round(187 * dpr), Math.round(333 * dpr), 1, 1).data;
      const mid = ctx.getImageData(Math.round(262 * dpr), Math.round(333 * dpr), 1, 1).data;
      return {
        corner: [corner[0], corner[1], corner[2]],
        center: [center[0], center[1], center[2]],
        mid: [mid[0], mid[1], mid[2]],
      };
    });
    expect(initialSample).not.toBeNull();
    expect(initialSample!.corner).toEqual([0, 0, 0]);
    expect(initialSample!.center[2]).toBeGreaterThan(100);
    expect(initialSample!.mid).toEqual([0, 0, 0]);

    // Change slider value to 28 (expands radius to ~105px)
    await slider.fill("28");
    await expect(slider).toHaveValue("28");
    await slider.dispatchEvent("input");

    // Sample mid pixel again: now within expanded hole (radius 105px > 75px)
    const expandedSample = await pageBob.evaluate(() => {
      const cv = document.querySelector<HTMLCanvasElement>(".wx-srv-view-once-overlay canvas");
      if (!cv) return null;
      const ctx = cv.getContext("2d");
      if (!ctx) return null;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const mid = ctx.getImageData(Math.round(262 * dpr), Math.round(333 * dpr), 1, 1).data;
      return {
        mid: [mid[0], mid[1], mid[2]],
      };
    });
    expect(expandedSample).not.toBeNull();
    // Mid point is now inside the expanded spotlight hole (shows image color!)
    expect(expandedSample!.mid[2]).toBeGreaterThan(100);

    // Close viewer via close button
    await overlay.locator(".wx-srv-view-once-close").click();
    await expect(overlay).toBeHidden();

    await contextAlice.close();
    await contextBobMobile.close();
  });

  // Architect ratification condition #7 (decisions/00169): jsdom cannot see CSS clipping, so a
  // real-click e2e must assert both a genuine bounding box AND that `elementFromPoint` at that
  // box's centre resolves to the control itself — the stronger check `toBeVisible()` alone can
  // miss (a fully see-through overlay stacked above it with a higher z-index would still pass
  // `toBeVisible()` while silently eating the real click).
  async function assertRealClickTarget(
    page: Page,
    locator: Locator,
    matchSelector: string,
    viewportWidth: number,
    viewportHeight: number,
  ): Promise<void> {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewportHeight);

    const centerX = box!.x + box!.width / 2;
    const centerY = box!.y + box!.height / 2;
    const hitsControl = await page.evaluate(
      ({ x, y, selector }) => {
        const el = document.elementFromPoint(x, y);
        return el !== null && el.closest(selector) !== null;
      },
      { x: centerX, y: centerY, selector: matchSelector },
    );
    expect(hitsControl).toBe(true);
  }

  for (const viewport of [
    { name: "desktop", width: 1280, height: 800, isMobile: false, hasTouch: false },
    { name: "360px phone", width: 360, height: 780, isMobile: true, hasTouch: true },
    { name: "390px phone", width: 390, height: 844, isMobile: true, hasTouch: true },
  ]) {
    test(`sending through the real composer button at ${viewport.name}: the button and sheet are genuinely visible and hit-testable, not merely present in the DOM (operator report, round 2: the original per-chip badge's picker was clipped invisible by its own thumbnail)`, async ({
      browser,
    }) => {
      const contextAlice = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.isMobile,
        hasTouch: viewport.hasTouch,
        extraHTTPHeaders: { "CF-Access-Authenticated-User-Email": "alice@example.com" },
      });
      const contextBob = await browser.newContext({
        extraHTTPHeaders: { "CF-Access-Authenticated-User-Email": "bob@example.com" },
      });

      const pageAlice = await contextAlice.newPage();
      const pageBob = await contextBob.newPage();

      await unlockServer(pageAlice, "Alice");
      await unlockServer(pageBob, "Bob");

      await pageAlice.locator('input[type="file"]').setInputFiles(PHOTO);

      const viewOnceButton = pageAlice.locator(".wx-srv-view-once-toggle-button");
      await expect(viewOnceButton).toHaveText("⏱ View once");
      await assertRealClickTarget(
        pageAlice,
        viewOnceButton,
        ".wx-srv-view-once-toggle-button",
        viewport.width,
        viewport.height,
      );

      await viewOnceButton.click();
      const sheet = pageAlice.locator(".wx-srv-view-once-sheet");
      // The real regression: the old picker existed in the DOM but was clipped to zero visible
      // area by its thumbnail's `overflow: hidden`. A bounding box plus `elementFromPoint` is
      // exactly what a DOM-presence check in a unit test cannot see.
      await assertRealClickTarget(pageAlice, sheet, ".wx-srv-view-once-sheet", viewport.width, viewport.height);
      // Condition #1: the sheet shows the targeted file's own thumbnail.
      await expect(sheet.locator(".wx-srv-view-once-sheet-thumb img")).toBeVisible();
      await expect(sheet.locator(".wx-srv-view-once-sheet-filename")).toHaveText(/\.jpg$/);

      await sheet.locator(".wx-srv-view-once-durations button", { hasText: "2 s" }).click();
      await expect(sheet).toBeHidden();
      await expect(viewOnceButton).toHaveText(/2s/);
      await expect(viewOnceButton).toHaveClass(/wx-srv-view-once-toggle-active/);
      // Condition #4: the chip itself carries a small marker, inside its own box.
      await expect(pageAlice.locator(".wx-srv-view-once-chip-marker")).toHaveText(/2s/);

      await pageAlice.locator(".wx-chat-send-button").click();

      const bobBubble = pageBob.locator(".wx-srv-bubble").filter({ has: pageBob.locator(".wx-srv-view-once-tap-btn") });
      await expect(bobBubble).toBeVisible({ timeout: 5000 });
      await expect(bobBubble.locator(".wx-srv-view-once-card-sub")).toContainText("2 s");

      await contextAlice.close();
      await contextBob.close();
    });
  }

  test("the view-once sheet's Escape key is not swallowed: it still triggers the panic lock rather than merely closing the sheet (condition #6)", async ({
    browser,
  }) => {
    const contextAlice = await browser.newContext({
      extraHTTPHeaders: { "CF-Access-Authenticated-User-Email": "alice@example.com" },
    });
    const pageAlice = await contextAlice.newPage();
    await unlockServer(pageAlice, "Alice");

    await pageAlice.locator('input[type="file"]').setInputFiles(PHOTO);
    const viewOnceButton = pageAlice.locator(".wx-srv-view-once-toggle-button");
    await expect(viewOnceButton).toBeEnabled();
    await viewOnceButton.click();

    const sheet = pageAlice.locator(".wx-srv-view-once-sheet");
    await expect(sheet).toBeVisible();

    await pageAlice.keyboard.press("Escape");

    // The panic lock fires (the real thread is torn down), not merely the sheet closing.
    await expect(pageAlice.locator(".wx-srv-thread")).toHaveCount(0);

    await contextAlice.close();
  });
});
