// E2E for reply-to-a-message (round 2 ruling item 10,
// spec/server-chat/04-round2-rulings.md, "ITEM 10 — REPLY TO A MESSAGE").
// Same fixture-server conventions as server-chat.spec.ts (one project per
// spec file, no per-test reset — every assertion below filters by a tag
// unique to its own test).

import { expect, test } from "../fixtures";
import type { Page } from "@playwright/test";
import { trackConsoleErrors } from "./helpers";

const MULTI_TAP_INTERVAL_MS = 400;

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

async function keepAlive(page: Page): Promise<void> {
  await page.mouse.move(Math.random() * 100, Math.random() * 100);
}

async function waitVisible(locator: ReturnType<Page["locator"]>, keepAlivePage: Page): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await keepAlive(keepAlivePage);
    if (await locator.first().isVisible().catch(() => false)) return;
    await keepAlivePage.waitForTimeout(500);
  }
  await expect(locator).toBeVisible({ timeout: 3000 });
}

test.describe("server-reply.spec.ts (round 2 ruling item 10)", () => {
  test("desktop: reply via the message menu, quote on the sent bubble, tap-to-scroll highlights the original", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errorsA = trackConsoleErrors(pageA);
    const errorsB = trackConsoleErrors(pageB);
    const tag = `reply-desktop-${Date.now()}`;
    const originalText = `${tag}: original message from Josh`;
    const replyText = `${tag}: reply from Purdy`;

    await unlockServer(pageA, "Josh");
    await unlockServer(pageB, "Purdy");

    await pageA.locator(".wx-srv-thread-view textarea").fill(originalText);
    await pageA.locator(".wx-srv-thread-view .wx-chat-send-button").click();
    const originalBubbleB = pageB.locator(".wx-srv-bubble").filter({ hasText: originalText });
    await waitVisible(originalBubbleB, pageB);

    // Purdy picks Reply from the message menu.
    await originalBubbleB.hover();
    await originalBubbleB.locator(".wx-srv-message-actions-trigger").click();
    await originalBubbleB.getByRole("menuitem", { name: "Reply" }).click();

    const replyBar = pageB.locator(".wx-srv-reply-bar");
    await expect(replyBar).toBeVisible();
    await expect(replyBar.locator(".wx-srv-reply-bar-label")).toHaveText("Replying to Josh");
    await expect(replyBar.locator(".wx-srv-quote-text")).toHaveText(originalText);
    // §(4): picking Reply focuses the input.
    await expect(pageB.locator(".wx-srv-thread-view textarea")).toBeFocused();

    await pageB.locator(".wx-srv-thread-view textarea").fill(replyText);
    await pageB.locator(".wx-srv-thread-view .wx-chat-send-button").click();
    await expect(replyBar).toBeHidden(); // clears at once

    const replyBubbleA = pageA.locator(".wx-srv-bubble").filter({ hasText: replyText });
    await waitVisible(replyBubbleA, pageA);
    const quote = replyBubbleA.locator(".wx-srv-quote");
    await expect(quote).toBeVisible();
    await expect(quote).toHaveAttribute("aria-label", "Show the original message from You");
    await expect(quote.locator(".wx-srv-quote-text")).toHaveText(originalText);

    // Tapping the quote scrolls to and highlights the original. Scoped to
    // `.wx-srv-bubble-mine` (Josh's own message, on Josh's page) rather than
    // a bare text filter — the reply bubble also CONTAINS the original text
    // via its own quote, and would otherwise strict-mode-match too.
    const originalBubbleA = pageA.locator(".wx-srv-bubble-mine").filter({ hasText: originalText });
    await quote.click();
    await expect(originalBubbleA).toHaveClass(/wx-srv-bubble-highlighted/);
    await expect(originalBubbleA).toBeInViewport();
    await expect(originalBubbleA).not.toHaveClass(/wx-srv-bubble-highlighted/, { timeout: 3000 });

    expect(errorsA, `console errors on page A: ${errorsA.join("; ")}`).toEqual([]);
    expect(errorsB, `console errors on page B: ${errorsB.join("; ")}`).toEqual([]);
    await contextA.close();
    await contextB.close();
  });

  test("mobile (390x844): long-press, Reply, composer bar and quote never overflow the viewport", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    const page = await context.newPage();
    const errors = trackConsoleErrors(page);
    const tag = `reply-mobile-${Date.now()}`;
    const originalText = `${tag}: a fairly long original message so the quote snippet has real width to clamp`;

    await unlockServer(page, "Josh");
    await page.locator(".wx-srv-thread-view textarea").fill(originalText);
    await page.locator(".wx-srv-thread-view .wx-chat-send-button").click();
    const originalBubble = page.locator(".wx-srv-bubble").filter({ hasText: originalText });
    await expect(originalBubble).toBeVisible();
    // The bubble first shows as the optimistic "sending" echo, which the confirmed message then
    // REPLACES (a new element). Pressing the echo starts a 500ms long-press on an element that is
    // discarded mid-press on a slower runner (failed 2 of 3 CI runs), so wait for the confirmed
    // bubble, the only one carrying `data-message-seq`.
    await expect(originalBubble).toHaveAttribute("data-message-seq", /^\d+$/);

    const pointer = { pointerType: "touch", pointerId: 1, clientX: 40, clientY: 200, button: 0 };
    await originalBubble.dispatchEvent("pointerdown", pointer);
    await page.waitForTimeout(550);
    await expect(originalBubble.locator(".wx-srv-message-actions")).toBeVisible();
    await originalBubble.dispatchEvent("pointerup", pointer);
    await originalBubble.getByRole("menuitem", { name: "Reply" }).click();

    const replyBar = page.locator(".wx-srv-reply-bar");
    await expect(replyBar).toBeVisible();
    const viewportWidth = page.viewportSize()?.width ?? 390;
    const barBox = await replyBar.boundingBox();
    expect(barBox).not.toBeNull();
    if (barBox !== null) {
      expect(barBox.x).toBeGreaterThanOrEqual(0);
      expect(barBox.x + barBox.width).toBeLessThanOrEqual(viewportWidth + 1);
    }
    // The sender name/snippet wraps rather than being clipped.
    const cancelButton = replyBar.locator(".wx-srv-reply-bar-cancel");
    await expect(cancelButton).toBeVisible();
    const cancelBox = await cancelButton.boundingBox();
    expect(cancelBox).not.toBeNull();
    if (cancelBox !== null) {
      expect(cancelBox.x + cancelBox.width).toBeLessThanOrEqual(viewportWidth + 1);
    }

    await cancelButton.click();
    await expect(replyBar).toBeHidden();

    expect(errors, `console errors: ${errors.join("; ")}`).toEqual([]);
    await context.close();
  });

  test("deleting the target live-removes the quote from the reply on both users, with no tombstone", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const tag = `reply-erasure-${Date.now()}`;
    const originalText = `${tag}: doomed original`;
    const replyText = `${tag}: quoting the doomed one`;

    await unlockServer(pageA, "Josh");
    await unlockServer(pageB, "Purdy");

    await pageA.locator(".wx-srv-thread-view textarea").fill(originalText);
    await pageA.locator(".wx-srv-thread-view .wx-chat-send-button").click();
    // Scoped to `.wx-srv-bubble-mine` — once the reply exists, its quote
    // repeats the original text and would otherwise strict-mode-match too.
    const originalBubbleA = pageA.locator(".wx-srv-bubble-mine").filter({ hasText: originalText });
    await expect(originalBubbleA).toBeVisible();

    const originalBubbleB = pageB.locator(".wx-srv-bubble").filter({ hasText: originalText });
    await waitVisible(originalBubbleB, pageB);
    await originalBubbleB.hover();
    await originalBubbleB.locator(".wx-srv-message-actions-trigger").click();
    await originalBubbleB.getByRole("menuitem", { name: "Reply" }).click();
    await pageB.locator(".wx-srv-thread-view textarea").fill(replyText);
    await pageB.locator(".wx-srv-thread-view .wx-chat-send-button").click();

    const replyBubbleA = pageA.locator(".wx-srv-bubble").filter({ hasText: replyText });
    await waitVisible(replyBubbleA, pageA);
    await expect(replyBubbleA.locator(".wx-srv-quote")).toBeVisible();
    const replyBubbleB = pageB.locator(".wx-srv-bubble").filter({ hasText: replyText });
    await expect(replyBubbleB.locator(".wx-srv-quote")).toBeVisible();

    await keepAlive(pageA);
    await pageA.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
    await originalBubbleA.hover();
    await originalBubbleA.locator(".wx-srv-message-actions-trigger").click();
    await originalBubbleA.getByRole("menuitem", { name: "Delete for everyone" }).click();
    await originalBubbleA.locator(".wx-srv-message-delete-confirm-button").click();
    await expect(originalBubbleA).toHaveCount(0);

    // The reply itself survives on both sides, with its quote gone and no
    // "Original message deleted" placeholder anywhere.
    await expect(replyBubbleA.locator(".wx-srv-quote")).toBeHidden({ timeout: 3000 });
    await expect(replyBubbleA).toBeVisible();
    await expect(replyBubbleB.locator(".wx-srv-quote")).toBeHidden({ timeout: 3000 });
    await expect(replyBubbleB).toBeVisible();
    await expect(pageA.getByText("Original message deleted")).toHaveCount(0);
    await expect(pageB.getByText("Original message deleted")).toHaveCount(0);

    await contextA.close();
    await contextB.close();
  });
});
