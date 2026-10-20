// E2E for the good-night scene (spec/server-chat/goodnight-scene.md): a live "night night"
// from the other person plays the pixel-art night on the receiver only; a tap skips to the
// starfield behind the thread; reduced motion goes straight to the starfield; ordinary words
// like "tonight" never trigger it. Same fixture-server conventions as server-reply.spec.ts.

import { expect, test } from "../fixtures";
import type { Browser, Page } from "@playwright/test";
import { trackConsoleErrors } from "./helpers";

const MULTI_TAP_INTERVAL_MS = 400;

async function unlockServer(page: Page, name: string): Promise<void> {
  const configResponse = await page.request.post("/test/server/config");
  const { pin } = (await configResponse.json()) as { pin: string };

  await page.goto("/admin/server");
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
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
    await page.locator(".wx-srv-name-prompt-input").fill(name);
    await page.locator(".wx-srv-name-prompt-button").click();
  }
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator(".wx-srv-thread-view textarea").fill(text);
  await page.locator(".wx-srv-thread-view .wx-chat-send-button").click();
  await expect(page.locator(".wx-srv-bubble-mine").filter({ hasText: text })).toBeVisible();
}

async function pair(
  browser: Browser,
  receiver: { viewport?: { width: number; height: number }; reducedMotion?: "reduce" },
): Promise<{ sender: Page; receiver: Page; close: () => Promise<void> }> {
  const a = await browser.newContext();
  const b = await browser.newContext(receiver);
  const sender = await a.newPage();
  const recv = await b.newPage();
  await unlockServer(sender, "Josh");
  await unlockServer(recv, "Purdy");
  return {
    sender,
    receiver: recv,
    close: async () => {
      await a.close();
      await b.close();
    },
  };
}

test.describe("server-goodnight.spec.ts", () => {
  test("phone (390x844): the other person's night night plays the scene; a tap leaves the stars", async ({
    browser,
  }) => {
    const { sender, receiver, close } = await pair(browser, {
      viewport: { width: 390, height: 844 },
    });
    const errors = trackConsoleErrors(receiver);
    const tag = `gn-${Date.now()}`;

    await send(sender, `${tag} Night night x`);

    // The receiver: a whole-viewport pixel canvas on the page, the chat UI faded out.
    const scene = receiver.locator("body > canvas.wx-srv-goodnight-canvas");
    await expect(scene).toBeVisible({ timeout: 10000 });
    await expect(receiver.locator(".wx-srv-thread-view.wx-srv-gn-hidden")).toHaveCount(1);
    const geometry = await scene.evaluate((c: HTMLCanvasElement) => ({
      w: c.width,
      cssW: Number.parseFloat(c.style.width),
      rendering: getComputedStyle(c).imageRendering,
    }));
    // Whole-number scale, nearest-neighbour: every scene pixel is a crisp square.
    expect(geometry.cssW % geometry.w).toBe(0);
    expect(geometry.rendering).toBe("pixelated");
    // The sender never sees it.
    await expect(sender.locator("canvas.wx-srv-goodnight-canvas")).toHaveCount(0);

    // Tap to skip: the stars move behind the thread and the messages come back.
    await receiver.waitForTimeout(1500);
    await scene.click();
    await expect(receiver.locator(".wx-srv-thread-wrap > .wx-srv-goodnight-bg canvas")).toHaveCount(1);
    await expect(receiver.locator("body > canvas.wx-srv-goodnight-canvas")).toHaveCount(0);
    await expect(receiver.locator(".wx-srv-thread-view.wx-srv-gn-hidden")).toHaveCount(0);
    await expect(receiver.locator(".wx-srv-bubble").filter({ hasText: tag })).toBeVisible();

    // Nothing overflows the phone viewport.
    const overflow = await receiver.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
    await close();
  });

  test("ordinary words never trigger it, and reduced motion goes straight to the stars", async ({
    browser,
  }) => {
    const { sender, receiver, close } = await pair(browser, { reducedMotion: "reduce" });
    const tag = `gn-rm-${Date.now()}`;

    await send(sender, `${tag} see you tonight, last night was fun`);
    await expect(receiver.locator(".wx-srv-bubble").filter({ hasText: "see you tonight" })).toBeVisible({
      timeout: 10000,
    });
    await receiver.waitForTimeout(800);
    await expect(receiver.locator("canvas.wx-srv-goodnight-canvas")).toHaveCount(0);

    await send(sender, `${tag} good night!`);
    await expect(receiver.locator(".wx-srv-bubble").filter({ hasText: "good night!" })).toBeVisible({
      timeout: 10000,
    });
    // Reduced motion: no full-screen scene at all, just the still starfield behind the thread.
    await expect(receiver.locator(".wx-srv-thread-wrap > .wx-srv-goodnight-bg canvas")).toHaveCount(1);
    await expect(receiver.locator("body > canvas.wx-srv-goodnight-canvas")).toHaveCount(0);
    await close();
  });
});
