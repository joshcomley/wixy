// E2E for going to each unheard voice note IN the chat: "Go to message" in the unread voice notes
// list closes it and scrolls the chat to that note (so you see what it answers), and a bar at the
// bottom of the thread, just above the composer, steps Previous / Next through the rest. Real layout
// only proves this: the note really is on screen after each step, and the bar really sits above the
// composer, inside a phone's width, with real 44 px targets. Two quick taps on Next never lock (R3).

import { expect, test } from "../fixtures";
import type { Locator, Page } from "@playwright/test";
import { trackConsoleErrors } from "./helpers";

test.describe.configure({ timeout: 120_000 });

/** Mirrors `MULTI_TAP_INTERVAL_MS` in admin-ui/src/server/constants.ts. */
const MULTI_TAP_INTERVAL_MS = 400;

async function unlockServer(page: Page, name: string): Promise<void> {
  const configResponse = await page.request.post("/test/server/config");
  const { pin } = (await configResponse.json()) as { pin: string };

  await page.goto("/admin/server");
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

  await expect(page.locator(".wx-srv-name-prompt:visible, .wx-srv-thread:visible")).toBeVisible({ timeout: 5000 });
  if (await page.locator(".wx-srv-name-prompt").isVisible()) {
    await page.locator(".wx-srv-name-prompt-input").fill(name);
    await page.locator(".wx-srv-name-prompt-button").click();
  }
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await expect(page.locator(".wx-srv-name-prompt")).toBeHidden();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

async function seedText(page: Page, label: string, count: number): Promise<void> {
  const response = await page.request.post("/test/server/seed-messages", {
    data: { count, spreadS: 1, startAgoS: 0, label, sender: "Purdy" },
  });
  expect(response.ok()).toBe(true);
}

async function seedVoice(page: Page): Promise<string> {
  const response = await page.request.post("/test/server/seed-voice", { data: { sender: "Purdy", seconds: 3 } });
  expect(response.ok()).toBe(true);
  return String(((await response.json()) as { seq: number }).seq);
}

async function humanPause(page: Page): Promise<void> {
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

function noteBubble(page: Page, seq: string): Locator {
  return page.locator(`.wx-srv-message-list .wx-srv-bubble[data-message-seq="${seq}"]`);
}

/** The bubble sits within the thread's visible box (allowing the smooth scroll to finish). */
async function expectInView(page: Page, seq: string): Promise<void> {
  await expect
    .poll(async () => {
      const b = await noteBubble(page, seq).boundingBox();
      const t = await page.locator(".wx-srv-thread").boundingBox();
      if (b === null || t === null) return false;
      return b.y >= t.y - 1 && b.y + b.height <= t.y + t.height + 1;
    }, { message: `voice note ${seq} on screen` })
    .toBe(true);
}

async function expectRealTarget(page: Page, locator: Locator, what: string): Promise<void> {
  await expect(locator, what).toBeVisible();
  const box = (await locator.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.height, `${what} height`).toBeGreaterThanOrEqual(43.5);
  expect(box.x, `${what} left`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${what} right`).toBeLessThanOrEqual(view.width + 0.5);
  const hit = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return at !== null && (at === el || el.contains(at));
  });
  expect(hit, `${what} is what a tap at its centre hits`).toBe(true);
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 360, height: 780 },
] as const) {
  test(`${viewport.width}px: Go to message shows an unheard note in the chat; Previous / Next step through the rest`, async ({ browser }) => {
    const context = await browser.newContext({ viewport, hasTouch: true });
    // This device has been counting unheard notes for a while (heardStore.ts): without it, a fresh
    // device starts counting at the first message it sees from the other person, which races the
    // seeding below and can drop the first note as "from before".
    await context.addInitScript(() => {
      window.localStorage.setItem("wx-srv-voice-heard", JSON.stringify({ since: 0, ids: [] }));
    });
    const page = await context.newPage();
    const errors = trackConsoleErrors(page);
    const label = `unheard-nav-${viewport.width}-${Date.now()}`;
    await unlockServer(page, "Josh");

    // After this device first ran the feature: three voice notes from Purdy, each after some chat,
    // then enough chat to push them all off the top.
    await seedText(page, `${label} before-1`, 2);
    const first = await seedVoice(page);
    await seedText(page, `${label} before-2`, 2);
    const second = await seedVoice(page);
    await seedText(page, `${label} before-3`, 2);
    const third = await seedVoice(page);
    await seedText(page, `${label} after`, 30);

    const tab = page.locator(".wx-srv-unheard-tab");
    await expect(tab).toHaveText("3 unread voice notes", { timeout: 15_000 });
    await humanPause(page);
    await tab.click();
    await expect(page.locator(".wx-srv-unheard-view")).toBeVisible();

    // Go to the middle one.
    const goto = page.locator(`.wx-srv-unheard-item[data-message-seq="${second}"] .wx-srv-unheard-goto`);
    await expectRealTarget(page, goto, "Go to message");
    await humanPause(page);
    await goto.click();
    await expect(page.locator(".wx-srv-unheard-view")).toBeHidden();
    await expectInView(page, second);
    await expect(noteBubble(page, second)).toHaveClass(/wx-srv-bubble-highlighted/);
    // A message arriving now must not pull the chat back to the bottom, away from the note.
    await seedText(page, `${label} meanwhile`, 1);
    await expect(page.locator(".wx-srv-bubble-text", { hasText: `${label} meanwhile #1` })).toHaveCount(1);
    await expectInView(page, second);

    const nav = page.locator(".wx-srv-unheard-nav");
    await expect(nav).toBeVisible();
    await expect(nav.locator(".wx-srv-unheard-pos")).toHaveText("2 of 3 unread voice notes");
    await expect(tab).toBeHidden();
    // The bar sits above the composer, never over it, and fits the phone.
    const navBox = (await nav.boundingBox())!;
    const composerBox = (await page.locator(".wx-chat-composer").boundingBox())!;
    expect(navBox.y + navBox.height).toBeLessThanOrEqual(composerBox.y + 0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const button of [".wx-srv-unheard-prev", ".wx-srv-unheard-next", ".wx-srv-unheard-nav-close"]) {
      await expectRealTarget(page, nav.locator(button), button);
    }

    // Next: the newest. No Next beyond it.
    await humanPause(page);
    await nav.locator(".wx-srv-unheard-next").click();
    await expectInView(page, third);
    await expect(nav.locator(".wx-srv-unheard-pos")).toHaveText("3 of 3 unread voice notes");
    await expect(nav.locator(".wx-srv-unheard-next")).toBeHidden();

    // Previous twice, quickly (well inside the double-tap window): never a lock.
    await nav.locator(".wx-srv-unheard-prev").click();
    await page.waitForTimeout(120);
    await nav.locator(".wx-srv-unheard-prev").click();
    await expect(page.locator(".wx-srv-thread")).toBeVisible();
    await expectInView(page, first);
    await expect(nav.locator(".wx-srv-unheard-pos")).toHaveText("1 of 3 unread voice notes");
    await expect(nav.locator(".wx-srv-unheard-prev")).toBeHidden();

    // ✕ closes the bar; the count tab is back (the notes are still unheard).
    await humanPause(page);
    await nav.locator(".wx-srv-unheard-nav-close").click();
    await expect(nav).toBeHidden();

    expect(errors).toEqual([]);
    await context.close();
  });
}
