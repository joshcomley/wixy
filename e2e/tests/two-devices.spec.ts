// The shared two-device helper (two-devices.ts), proven deterministically rather than by hoping a loaded box stalls:
// the second device's unlock is made to take 11 s, longer than the 10 s idle lock (R7).
//
//  - the CONTROL: unlocking the two devices one after the other, with the keep-awake started afterwards (the old
//    ordering of five specs), leaves the first device back on the decoy;
//  - `unlockTogether`: the same stall, and the first device is still unlocked.
//
// If the control ever stops locking (the idle lock changes), the second test would pass for the wrong reason, so the
// control is what keeps it honest.

import { expect, test } from "../fixtures";
import type { Page } from "@playwright/test";
import { keepPagesAwake, unlockTogether } from "./two-devices";

const STALL_MS = 11_000;

async function unlockServer(page: Page, name: string): Promise<void> {
  const { pin } = (await (await page.request.post("/test/server/config")).json()) as { pin: string };
  await page.goto("/admin/server");
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  await page.locator(".wx-srv-panel").click();
  await expect(page.locator(".wx-srv-affordance")).toBeVisible();
  await page.waitForTimeout(500); // the product's 400 ms reveal debounce
  await page.locator(".wx-srv-affordance").click();
  await expect(page.locator(".wx-srv-pinpad")).toBeVisible();
  for (const digit of pin) await page.locator(`.wx-srv-pinpad-key-digit:text-is("${digit}")`).click();
  await page.locator(".wx-srv-pinpad-key-submit").click();
  await expect(page.locator(".wx-srv-name-prompt:visible, .wx-srv-thread:visible")).toBeVisible({ timeout: 5000 });
  if (await page.locator(".wx-srv-name-prompt").isVisible()) {
    await page.locator(".wx-srv-name-prompt-input").fill(name);
    await page.locator(".wx-srv-name-prompt-button").click();
  }
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
}

/** The second device's unlock, made as slow as a loaded box makes it. */
async function slowSecondUnlock(page: Page, name: string): Promise<void> {
  if (name === "Second") await page.waitForTimeout(STALL_MS);
  await unlockServer(page, name);
}

test.describe("two-devices.ts", () => {
  test("control: unlocking one device after the other, with the keep-awake started afterwards, locks the first", async ({ browser }) => {
    const a = await browser.newContext();
    const b = await browser.newContext();
    try {
      const first = await a.newPage();
      const second = await b.newPage();
      await slowSecondUnlock(first, "First");
      await slowSecondUnlock(second, "Second"); // 11 s with nothing touching the first device
      const stop = keepPagesAwake([first, second]); // the old ordering: too late
      await expect(first.locator(".wx-srv-thread")).toHaveCount(0);
      await expect(first.locator(".wx-srv-decoy")).toBeVisible();
      stop();
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("unlockTogether: the same 11 s stall leaves the first device unlocked", async ({ browser }) => {
    const a = await browser.newContext();
    const b = await browser.newContext();
    try {
      const first = await a.newPage();
      const second = await b.newPage();
      await unlockTogether(slowSecondUnlock, [[first, "First"], [second, "Second"]]);
      await expect(first.locator(".wx-srv-thread")).toBeVisible();
      await expect(second.locator(".wx-srv-thread")).toBeVisible();
    } finally {
      await a.close(); // also stops the keep-awake: its pages close
      await b.close();
    }
  });

  test("unlockTogether with keepAwakeAfter: false stops the keep-awake once both are unlocked", async ({ browser }) => {
    const a = await browser.newContext();
    const b = await browser.newContext();
    try {
      const first = await a.newPage();
      const second = await b.newPage();
      await unlockTogether(unlockServer, [[first, "First"], [second, "Second"]], { keepAwakeAfter: false });
      // Nothing keeps them awake now, so the idle lock the call specs assert on is the real one.
      await expect(first.locator(".wx-srv-thread")).toHaveCount(0, { timeout: 20_000 });
    } finally {
      await a.close();
      await b.close();
    }
  });
});
