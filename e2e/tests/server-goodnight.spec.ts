// E2E for the good-night scene (spec/server-chat/goodnight-scene.md): Bubble's "night night"
// plays the pixel-art night on her screen as she sends it and on Cupcake's as it arrives;
// Cupcake's never plays it; a tap skips to the starfield behind the thread; reduced motion goes
// straight to the starfield; ordinary words like "tonight" never trigger it. Same fixture-server conventions as server-reply.spec.ts.

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
  opts: {
    bubble?: { viewport?: { width: number; height: number }; reducedMotion?: "reduce" };
    cupcake?: { viewport?: { width: number; height: number }; reducedMotion?: "reduce" };
  } = {},
): Promise<{ bubble: Page; cupcake: Page; close: () => Promise<void> }> {
  const a = await browser.newContext(opts.bubble ?? {});
  const b = await browser.newContext(opts.cupcake ?? {});
  const bubble = await a.newPage();
  const cupcake = await b.newPage();
  await unlockServer(bubble, "Bubble");
  await unlockServer(cupcake, "Cupcake");
  return {
    bubble,
    cupcake,
    close: async () => {
      await a.close();
      await b.close();
    },
  };
}

const SCENE = "body > canvas.wx-srv-goodnight-canvas";
const STARS = ".wx-srv-thread-wrap > .wx-srv-goodnight-bg canvas";

test.describe("server-goodnight.spec.ts", () => {
  test("Bubble's night night plays the scene on her phone and on Cupcake's screen; a tap leaves the stars", async ({
    browser,
  }) => {
    const { bubble, cupcake, close } = await pair(browser, {
      bubble: { viewport: { width: 390, height: 844 } },
    });
    const errors = trackConsoleErrors(bubble);
    const tag = `gn-${Date.now()}`;

    await send(bubble, `${tag} Night night x`);

    // Her own screen, as she sends it: a whole-viewport pixel canvas, the chat UI faded out.
    const scene = bubble.locator(SCENE);
    await expect(scene).toBeVisible({ timeout: 10000 });
    await expect(bubble.locator(".wx-srv-thread-view.wx-srv-gn-hidden")).toHaveCount(1);
    const geometry = await scene.evaluate((c: HTMLCanvasElement) => ({
      w: c.width,
      cssW: Number.parseFloat(c.style.width),
      rendering: getComputedStyle(c).imageRendering,
    }));
    // Whole-number scale, nearest-neighbour: every scene pixel is a crisp square.
    expect(geometry.cssW % geometry.w).toBe(0);
    expect(geometry.rendering).toBe("pixelated");
    // ...and on Cupcake's screen as it arrives.
    await expect(cupcake.locator(SCENE)).toBeVisible({ timeout: 10000 });

    // Tap to skip: the stars move behind the thread and the messages come back.
    await bubble.waitForTimeout(1500);
    await scene.click();
    await expect(bubble.locator(STARS)).toHaveCount(1);
    await expect(bubble.locator(SCENE)).toHaveCount(0);
    await expect(bubble.locator(".wx-srv-thread-view.wx-srv-gn-hidden")).toHaveCount(0);
    await expect(bubble.locator(".wx-srv-bubble").filter({ hasText: tag })).toBeVisible();

    // Nothing overflows the phone viewport.
    const overflow = await bubble.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
    await close();
  });

  test("Cupcake's good night never plays it, on either screen", async ({ browser }) => {
    const { bubble, cupcake, close } = await pair(browser);
    const tag = `gn-cc-${Date.now()}`;

    await send(cupcake, `${tag} good night`);
    await expect(bubble.locator(".wx-srv-bubble").filter({ hasText: tag })).toBeVisible({
      timeout: 10000,
    });
    await bubble.waitForTimeout(1000);
    await expect(bubble.locator("canvas.wx-srv-goodnight-canvas")).toHaveCount(0);
    await expect(cupcake.locator("canvas.wx-srv-goodnight-canvas")).toHaveCount(0);
    await close();
  });

  test("ordinary words never trigger it, and reduced motion goes straight to the stars", async ({
    browser,
  }) => {
    const { bubble, cupcake, close } = await pair(browser, {
      cupcake: { reducedMotion: "reduce" },
    });
    const tag = `gn-rm-${Date.now()}`;

    await send(bubble, `${tag} see you tonight, last night was fun`);
    await expect(cupcake.locator(".wx-srv-bubble").filter({ hasText: "see you tonight" })).toBeVisible({
      timeout: 10000,
    });
    await cupcake.waitForTimeout(800);
    await expect(cupcake.locator("canvas.wx-srv-goodnight-canvas")).toHaveCount(0);
    await expect(bubble.locator("canvas.wx-srv-goodnight-canvas")).toHaveCount(0);

    await send(bubble, `${tag} good night!`);
    await expect(cupcake.locator(".wx-srv-bubble").filter({ hasText: "good night!" })).toBeVisible({
      timeout: 10000,
    });
    // Reduced motion: no full-screen scene at all, just the still starfield behind the thread.
    await expect(cupcake.locator(STARS)).toHaveCount(1);
    await expect(cupcake.locator(SCENE)).toHaveCount(0);
    await close();
  });
});
