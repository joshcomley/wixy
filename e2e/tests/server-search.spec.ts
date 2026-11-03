// E2E for three things about reading back through the chat, on real layout at phone widths:
// Search (find a message, land on it in the chat, step Older / Newer), the date strip that stays at
// the top once you have scrolled back before today, and Message info in a message's ⋯ menu.

import { expect, test } from "../fixtures";
import type { Locator, Page } from "@playwright/test";
import { trackConsoleErrors } from "./helpers";

test.describe.configure({ timeout: 180_000 });

/** Mirrors `MULTI_TAP_INTERVAL_MS` in admin-ui/src/server/constants.ts. */
const MULTI_TAP_INTERVAL_MS = 400;
const DAY_S = 86_400;

async function humanPause(page: Page): Promise<void> {
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

async function unlockServer(page: Page, name: string): Promise<void> {
  const configResponse = await page.request.post("/test/server/config");
  const { pin } = (await configResponse.json()) as { pin: string };
  await page.goto("/admin/server");
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  await page.locator(".wx-srv-panel").click();
  await expect(page.locator(".wx-srv-affordance")).toBeVisible();
  await humanPause(page);
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
  await humanPause(page);
}

async function seed(page: Page, label: string, count: number, startAgoS: number, spreadS = 1): Promise<void> {
  const response = await page.request.post("/test/server/seed-messages", {
    data: { count, spreadS, startAgoS, label, sender: "Purdy" },
  });
  expect(response.ok()).toBe(true);
}

async function openSearch(page: Page): Promise<void> {
  await page.locator(".wx-srv-more-button").click();
  await page.locator(".wx-srv-more-search").click();
  await expect(page.locator(".wx-srv-search-view")).toBeVisible();
}

function bubbleWith(page: Page, text: string): Locator {
  return page.locator(".wx-srv-message-list .wx-srv-bubble", { hasText: text });
}

async function expectInView(page: Page, bubble: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const b = await bubble.boundingBox();
      const t = await page.locator(".wx-srv-thread").boundingBox();
      if (b === null || t === null) return false;
      return b.y >= t.y - 1 && b.y + b.height <= t.y + t.height + 1;
    }, { message: "the message is on screen" })
    .toBe(true);
}

async function expectFits(page: Page, locator: Locator, what: string): Promise<void> {
  await expect(locator, what).toBeVisible();
  const box = (await locator.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.height, `${what} height`).toBeGreaterThanOrEqual(43.5);
  expect(box.x, `${what} left`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${what} right`).toBeLessThanOrEqual(view.width + 0.5);
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
] as const) {
  test(`${viewport.width}px: search finds an old message, shows it in the chat and steps through the rest`, async ({ browser }) => {
    const context = await browser.newContext({ viewport, hasTouch: true });
    const page = await context.newPage();
    const errors = trackConsoleErrors(page);
    const stamp = `s${viewport.width}x${Date.now()}`;

    // Far more history than the first page loads, and all of it there BEFORE unlocking, so the
    // oldest match is not in the thread until we go to it.
    await seed(page, `${stamp} needle`, 1, 40 * DAY_S);
    await seed(page, `${stamp} filler-old`, 150, 39 * DAY_S);
    await seed(page, `${stamp} needle`, 2, 20 * DAY_S);
    await seed(page, `${stamp} filler-new`, 60, 10 * DAY_S);
    await unlockServer(page, "Josh");
    await expect(page.locator(".wx-srv-bubble-text", { hasText: `${stamp} filler-new #60` })).toHaveCount(1, { timeout: 15_000 });
    await humanPause(page);

    await openSearch(page);
    const input = page.locator(".wx-srv-search-input");
    await expect(input).toBeFocused();
    expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    expect(await input.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);

    // What was searched for travels in the body of a POST and never in a URL.
    const urls: string[] = [];
    page.on("request", (request) => urls.push(request.url()));
    await input.fill(`NEEDLE ${stamp}`);
    const items = page.locator(".wx-srv-search-item");
    await expect(items).toHaveCount(3);
    await expect(page.locator(".wx-srv-search-summary")).toHaveText("3 messages");
    expect(urls.filter((url) => url.toLowerCase().includes("needle"))).toEqual([]);
    await expect(items.first().locator("mark").last()).toHaveText("needle");
    await expectFits(page, items.first(), "a result");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // The last result is the oldest: it is not loaded until we go there.
    const oldest = bubbleWith(page, `${stamp} needle #1`);
    await expect(items.last()).toContainText("needle #1");
    await humanPause(page);
    await items.last().click();
    await expect(page.locator(".wx-srv-search-view")).toBeHidden();
    const nav = page.locator(".wx-srv-search-nav");
    await expect(nav.locator(".wx-srv-search-pos")).toHaveText("3 of 3", { timeout: 15_000 });
    await expect(oldest.first()).toBeVisible();
    await expectInView(page, oldest.first());
    await expect(oldest.first()).toHaveClass(/wx-srv-bubble-highlighted/);
    expect(await page.evaluate(() => (CSS as unknown as { highlights: Map<string, { size: number }> }).highlights.get("wx-srv-search-match")?.size)).toBeGreaterThan(0);

    // A message arriving now waits with the latest messages, and doesn't move the chat.
    await seed(page, `${stamp} meanwhile`, 1, 0);
    await humanPause(page);
    await expect(page.locator(".wx-srv-bubble-text", { hasText: `${stamp} meanwhile #1` })).toHaveCount(0);
    await expectInView(page, oldest.first());

    // The bar sits above the composer, fits, and has real targets.
    const navBox = (await nav.boundingBox())!;
    const composerBox = (await page.locator(".wx-chat-composer").boundingBox())!;
    expect(navBox.y + navBox.height).toBeLessThanOrEqual(composerBox.y + 0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(nav.locator(".wx-srv-search-older")).toBeHidden();
    await expectFits(page, nav.locator(".wx-srv-search-newer"), "Newer");
    await expectFits(page, nav.locator(".wx-srv-search-nav-close"), "close");

    // The way back to the latest messages is above the bar, and takes you there.
    const pill = page.locator(".wx-srv-jump-pill");
    await expect(pill).toHaveText("\u2193 Latest messages");
    await expectFits(page, pill, "Latest messages");
    const pillBox = (await pill.boundingBox())!;
    expect(pillBox.y + pillBox.height).toBeLessThanOrEqual((await nav.boundingBox())!.y + 0.5);
    // Only that stretch is on screen, not everything since.
    expect(await page.locator(".wx-srv-message-list .wx-srv-bubble").count()).toBeLessThan(120);

    // Scrolling down from there carries on through newer messages.
    const thread = page.locator(".wx-srv-thread");
    const before = await page.locator(".wx-srv-message-list .wx-srv-bubble").count();
    await thread.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect.poll(() => page.locator(".wx-srv-message-list .wx-srv-bubble").count()).toBeGreaterThan(before);
    // More appeared below, and the reader wasn't carried along to the end of it.
    expect(await thread.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(100);

    await humanPause(page);
    await pill.click();
    await expect(page.locator(".wx-srv-bubble-text", { hasText: `${stamp} meanwhile #1` })).toBeVisible();
    await expectInView(page, bubbleWith(page, `${stamp} meanwhile #1`).first());
    await expect(pill).toBeHidden();
    // The bar still knows where it was.
    await expect(nav.locator(".wx-srv-search-pos")).toHaveText("3 of 3");

    await humanPause(page);

    // Newer twice, quickly (well inside the double-tap window): never a lock.
    await nav.locator(".wx-srv-search-newer").click();
    await page.waitForTimeout(120);
    await nav.locator(".wx-srv-search-newer").click();
    await expect(page.locator(".wx-srv-thread")).toBeVisible();
    await expect(nav.locator(".wx-srv-search-pos")).toHaveText("1 of 3");
    await expect(nav.locator(".wx-srv-search-newer")).toBeHidden();
    await expectInView(page, bubbleWith(page, `${stamp} needle #2`).first());

    // Back to the list, as it was.
    await humanPause(page);
    await nav.locator(".wx-srv-search-pos").click();
    await expect(page.locator(".wx-srv-search-view")).toBeVisible();
    await expect(input).toHaveValue(`NEEDLE ${stamp}`);
    await expect(items).toHaveCount(3);

    // The newest result, the very last message of its stretch, can be read clear of the bar.
    await humanPause(page);
    await page.locator(".wx-srv-search-close").click();
    await expect(nav).toBeHidden();
    await seed(page, `${stamp} lastword`, 1, 0);
    await expect(page.locator(".wx-srv-bubble-text", { hasText: `${stamp} lastword #1` })).toHaveCount(1);
    await humanPause(page);
    await openSearch(page);
    await input.fill(`lastword ${stamp}`);
    await expect(items).toHaveCount(1);
    await humanPause(page);
    await items.first().click();
    await expect(nav.locator(".wx-srv-search-pos")).toHaveText("1 of 1");
    await expect
      .poll(async () => {
        const bubble = (await bubbleWith(page, `${stamp} lastword #1`).first().boundingBox())!;
        return bubble.y + bubble.height <= (await nav.boundingBox())!.y + 0.5;
      }, { message: "the newest message is clear of the bar" })
      .toBe(true);

    // Back to the list.
    await humanPause(page);
    await nav.locator(".wx-srv-search-pos").click();
    await expect(page.locator(".wx-srv-search-view")).toBeVisible();
    await input.fill(`NEEDLE ${stamp}`);
    await expect(items).toHaveCount(3);

    // Nothing lingers once it is closed.
    await humanPause(page);
    await page.locator(".wx-srv-search-close").click();
    await expect(nav).toBeHidden();
    await humanPause(page);
    await openSearch(page);
    await expect(input).toHaveValue("");
    await expect(items).toHaveCount(0);
    await humanPause(page);
    await page.locator(".wx-srv-search-close").click();

    expect(errors).toEqual([]);
    await context.close();
  });

  test(`${viewport.width}px: a date strip stays at the top once you scroll back before today`, async ({ browser }) => {
    const context = await browser.newContext({ viewport, hasTouch: true });
    const page = await context.newPage();
    const errors = trackConsoleErrors(page);
    const stamp = `d${viewport.width}x${Date.now()}`;
    await unlockServer(page, "Josh");

    const thread = page.locator(".wx-srv-thread");
    const strip = page.locator(".wx-srv-day-strip");
    await seed(page, `${stamp} long-ago`, 40, 5 * DAY_S);
    await seed(page, `${stamp} yesterday`, 40, DAY_S);
    await seed(page, `${stamp} today`, 40, 60);
    await expect(page.locator(".wx-srv-bubble-text", { hasText: `${stamp} today #40` })).toHaveCount(1, { timeout: 15_000 });

    // At the newest messages the top of the screen is today: no strip.
    await expect
      .poll(() => thread.evaluate((el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 4))
      .toBe(true);
    await expect(strip).toBeHidden();

    // Scrolled into yesterday.
    await bubbleWith(page, `${stamp} yesterday #30`).first().evaluate((el) => el.scrollIntoView({ block: "start" }));
    await expect(strip).toBeVisible();
    await expect(strip).toHaveText("Yesterday");
    const stripBox = (await strip.locator("span").boundingBox())!;
    const threadBox = (await thread.boundingBox())!;
    expect(stripBox.y).toBeGreaterThanOrEqual(threadBox.y);
    expect(stripBox.x).toBeGreaterThanOrEqual(0);
    expect(stripBox.x + stripBox.width).toBeLessThanOrEqual(viewport.width);

    // A tap goes straight through it to the chat.
    expect(await strip.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");

    // Further back: the weekday and the date.
    await bubbleWith(page, `${stamp} long-ago #30`).first().evaluate((el) => el.scrollIntoView({ block: "start" }));
    const expected = await page.evaluate((ago) => new Date(Date.now() - ago * 1000).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), 5 * DAY_S);
    await expect(strip).toHaveText(expected);
    const [stripHeight, stripText] = await strip.locator("span").evaluate((el) => [el.getBoundingClientRect().height, el.textContent]);
    expect(stripText).toBe(expected);
    expect(stripHeight).toBeLessThan(60);

    // With the day's own separator right at the top it isn't said twice.
    await page.locator(".wx-srv-day-separator", { hasText: "Yesterday" }).first().evaluate((el) => el.scrollIntoView({ block: "start" }));
    await expect(strip).toBeHidden();

    // Back at the newest: gone again.
    await thread.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(strip).toBeHidden();

    expect(errors).toEqual([]);
    await context.close();
  });

  test(`${viewport.width}px: Message info shows the exact time and details`, async ({ browser }) => {
    const context = await browser.newContext({ viewport, hasTouch: false });
    const page = await context.newPage();
    const errors = trackConsoleErrors(page);
    const stamp = `i${viewport.width}x${Date.now()}`;
    await unlockServer(page, "Josh");
    await seed(page, `${stamp} about`, 1, 0);

    const bubble = bubbleWith(page, `${stamp} about #1`).first();
    await expect(bubble).toBeVisible({ timeout: 15_000 });
    await bubble.hover();
    await bubble.locator(".wx-srv-message-actions-trigger").click();
    const menu = bubble.locator(".wx-srv-message-actions");
    await expect(menu).toBeVisible();
    await expectFits(page, menu.locator(".wx-srv-message-action-info"), "Message info");
    await menu.locator(".wx-srv-message-action-info").click();

    const info = menu.locator(".wx-srv-message-info");
    await expect(info).toBeVisible();
    await expect(menu.locator(".wx-srv-message-actions-list")).toBeHidden();
    await expect(info.locator("dt", { hasText: "Sent" })).toBeVisible();
    await expect(info.locator("dd").first()).toHaveText(/\d{2}.\d{2}.\d{2}/);
    await expect(info.locator("dd").nth(1)).toHaveText("Purdy");
    await expect(info.locator("dd").nth(2)).toHaveText("Text message");
    await expect(info).toContainText("Message number");

    // The whole pane is on the phone's screen, and doesn't push the page sideways.
    await info.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
    const box = (await info.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // Back goes to the menu, and it opens fresh next time.
    await humanPause(page);
    await info.locator(".wx-srv-message-info-back").click();
    await expect(menu.locator(".wx-srv-message-actions-list")).toBeVisible();
    await expect(info).toBeHidden();

    expect(errors).toEqual([]);
    await context.close();
  });
}
