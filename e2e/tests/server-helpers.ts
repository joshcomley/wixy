// The ONE `unlockServer` every Server chat e2e spec uses (it used to be copied into eleven specs, each with its own
// 5 s wait for the post-PIN round trip, which a slow runner outran: PR 431's e2e run). A wait on a server round
// trip uses LOADED_WAIT_MS here, once; server-unlock-slow.spec.ts proves it by delaying the unlock response.

import { expect } from "../fixtures";
import type { Page } from "@playwright/test";

/** How long a wait on a server round trip may take on a loaded box (a dozen browsers on one machine). */
export const LOADED_WAIT_MS = 30_000;

/** Mirrors `MULTI_TAP_INTERVAL_MS` in admin-ui/src/server/constants.ts. */
export const MULTI_TAP_INTERVAL_MS = 400;

export async function unlockServer(page: Page, name: string): Promise<void> {
  const configResponse = await page.request.post("/test/server/config");
  const { pin } = (await configResponse.json()) as { pin: string };

  // Deep-link straight to the panel rather than loading /admin/pages and clicking the nav item: the shell
  // re-renders the current route once its first /api/admin/state answers (shell.ts loadState -> handleRoute),
  // which tears down the panel the click just mounted. A deep link renders the route exactly once.
  await page.goto("/admin/server");
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  await expect(page.locator(".wx-srv-affordance")).toBeHidden();

  await page.locator(".wx-srv-panel").click();
  await expect(page.locator(".wx-srv-affordance")).toBeVisible();
  // R2 v1.3's 400ms reveal-affordance debounce (decision #974): a tap on the button within this window of the tap
  // that revealed it doesn't open the pad.
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
  await page.locator(".wx-srv-affordance").click();
  await expect(page.locator(".wx-srv-pinpad")).toBeVisible();

  for (const digit of pin) {
    await page.locator(`.wx-srv-pinpad-key-digit:text-is("${digit}")`).click();
  }
  await page.locator(".wx-srv-pinpad-key-submit").click();

  await expect(page.locator(".wx-srv-name-prompt:visible, .wx-srv-thread:visible")).toBeVisible({
    timeout: LOADED_WAIT_MS,
  });
  if (await page.locator(".wx-srv-name-prompt").isVisible()) {
    // Nothing may be sent before a name exists: the thread view must stay hidden behind the prompt. Only a real
    // browser can prove it (`[hidden]` loses to a class's own `display`, see serverChatCss.test.ts).
    await expect(page.locator(".wx-srv-thread-view")).toBeHidden();
    await page.locator(".wx-srv-name-prompt-input").fill(name);
    await page.locator(".wx-srv-name-prompt-button").click();
  }
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await expect(page.locator(".wx-srv-name-prompt")).toBeHidden();
  // R3 (spec §6): two taps inside the chat view less than MULTI_TAP_INTERVAL_MS apart lock the panel instantly, so
  // let that window elapse and the tests keep a human tap cadence.
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

/** Unlocks again on a device that already has a name (a re-unlock after a lock or a reload): no name prompt is
 * expected, only the thread. `reload: false` stays on the page the lock left (the decoy is already showing). */
export async function unlockAgain(page: Page, options: { reload?: boolean } = {}): Promise<void> {
  const { pin } = (await (await page.request.post("/test/server/config")).json()) as { pin: string };
  if (options.reload ?? true) await page.goto("/admin/server");
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  await page.locator(".wx-srv-panel").click();
  await expect(page.locator(".wx-srv-affordance")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
  await page.locator(".wx-srv-affordance").click();
  await expect(page.locator(".wx-srv-pinpad")).toBeVisible();
  for (const digit of pin) {
    await page.locator(`.wx-srv-pinpad-key-digit:text-is("${digit}")`).click();
  }
  await page.locator(".wx-srv-pinpad-key-submit").click();
  await expect(page.locator(".wx-srv-thread")).toBeVisible({ timeout: LOADED_WAIT_MS });
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}
