// Phone layout of the Server chat (operator report, 2026-09-25): the message
// card sat 12px further in from the screen edge than the composer row, the
// composer's controls were four different heights/tops, and there was ~26px
// of dead space above the first message plus ~22px between the tab strip and
// the Server header. Real geometry only — jsdom cannot lay anything out — at
// the operator's phone width (CSS 402px). Tolerances are 1px (sub-pixel
// rounding); the fixes bring every figure below to an exact match.

import { expect, test, type Page } from "@playwright/test";

/** Mirrors `MULTI_TAP_INTERVAL_MS` in admin-ui/src/server/constants.ts. */
const MULTI_TAP_INTERVAL_MS = 400;

test.use({ viewport: { width: 402, height: 870 } });

async function unlockServer(page: Page, name: string): Promise<void> {
  const configResponse = await page.request.post("/test/server/config");
  const { pin } = (await configResponse.json()) as { pin: string };

  await page.goto("/admin/server");
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  await page.locator(".wx-srv-panel").click();
  await expect(page.locator(".wx-srv-affordance")).toBeVisible();
  // R2 v1.3's 400ms reveal-affordance debounce (server-chat.spec.ts, same wait).
  await page.waitForTimeout(500);
  await page.locator(".wx-srv-affordance").click();
  await expect(page.locator(".wx-srv-pinpad")).toBeVisible();
  for (const digit of pin) {
    await page.locator(`.wx-srv-pinpad-key-digit:text-is("${digit}")`).click();
  }
  await page.locator(".wx-srv-pinpad-key-submit").click();

  await expect(page.locator(".wx-srv-name-prompt:visible, .wx-srv-thread:visible")).toBeVisible({
    timeout: 5000,
  });
  if (await page.locator(".wx-srv-name-prompt").isVisible()) {
    await page.locator(".wx-srv-name-prompt-input").fill(name);
    await page.locator(".wx-srv-name-prompt-button").click();
  }
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await expect(page.locator(".wx-srv-name-prompt")).toBeHidden();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  });
  return found;
}

test("phone layout: one shared gutter, one control height, tight top spacing", async ({ page }) => {
  // The fixture server is shared across the whole suite, so earlier specs have
  // already put a long history in this thread; seeding a fresh pair on an
  // older day guarantees a day chip is in play whatever ran before.
  await page.request.post("/test/server/seed-messages", {
    data: { count: 2, label: "Layout probe", sender: "Fixture", startAgoS: 3_000_000, spreadS: 60 },
  });
  await unlockServer(page, "Cupcake");
  await expect(page.locator(".wx-srv-bubble").first()).toBeVisible();
  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);

  // -- 1. Side insets: header, card and composer share ONE gutter ------------
  const header = await box(page, ".wx-srv-thread-header");
  const card = await box(page, ".wx-srv-thread");
  const composer = await box(page, ".wx-chat-composer");
  const send = await box(page, ".wx-chat-send-button");
  const closeButton = await box(page, ".wx-srv-panic-button");

  expect.soft(Math.abs(card.left - composer.left)).toBeLessThanOrEqual(1);
  expect.soft(Math.abs(viewportWidth - card.right - (viewportWidth - composer.right))).toBeLessThanOrEqual(1);
  expect.soft(Math.abs(header.left - composer.left)).toBeLessThanOrEqual(1);
  expect.soft(Math.abs(header.right - composer.right)).toBeLessThanOrEqual(1);
  // The header's own controls reach the same right edge as Send.
  expect.soft(Math.abs(closeButton.right - send.right)).toBeLessThanOrEqual(1);
  // A modest phone gutter: not zero (touching the edge), not the old 24px.
  expect.soft(composer.left).toBeGreaterThanOrEqual(8);
  expect.soft(composer.left).toBeLessThanOrEqual(16);

  // -- 2. Composer row: attach / mic / input / Send are one height -----------
  const attach = await box(page, ".wx-chat-attach-button");
  const mic = await box(page, ".wx-srv-record-button");
  const input = await box(page, ".wx-chat-composer-input");
  const controls = { attach, mic, input, send };
  for (const [name, control] of Object.entries(controls)) {
    expect.soft(control.height, `${name} is a >=44px tap target`).toBeGreaterThanOrEqual(43.5);
    expect.soft(Math.abs(control.height - send.height), `${name} height matches Send`).toBeLessThanOrEqual(1);
    expect.soft(Math.abs(control.top - send.top), `${name} top matches Send`).toBeLessThanOrEqual(1);
  }
  // Icon buttons are square at the shared height.
  expect.soft(Math.abs(attach.width - attach.height)).toBeLessThanOrEqual(1);
  expect.soft(Math.abs(mic.width - mic.height)).toBeLessThanOrEqual(1);

  // -- 3. Top of the card: a small gap above the first content ---------------
  // Scroll to the very top and let older-history paging finish, so the first
  // element really is the start of the thread and not something scrolled away.
  let previousFirst = "";
  let stable = 0;
  for (let attempt = 0; attempt < 40 && stable < 3; attempt++) {
    await page.mouse.move(5 + attempt, 5);
    const first = await page.evaluate(() => {
      const thread = document.querySelector<HTMLElement>(".wx-srv-thread");
      if (thread !== null) thread.scrollTop = 0;
      const el = document.querySelector(".wx-srv-message-list")?.firstElementChild;
      return `${el?.className ?? ""}|${el?.textContent ?? ""}|${thread?.scrollTop ?? -1}`;
    });
    stable = first === previousFirst ? stable + 1 : 0;
    previousFirst = first;
    await page.waitForTimeout(150);
  }
  const gapAboveFirst = await page.evaluate(() => {
    const thread = document.querySelector(".wx-srv-thread");
    const first = document.querySelector(".wx-srv-message-list")?.firstElementChild;
    if (thread === null || first === null || first === undefined) return -1;
    return first.getBoundingClientRect().top - thread.getBoundingClientRect().top;
  });
  expect.soft(gapAboveFirst).toBeGreaterThan(0);
  expect.soft(gapAboveFirst).toBeLessThanOrEqual(12); // was 26

  // -- 4. Header gap: no padding of its own between the tab strip and Server -
  const mainTop = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".wx-main");
    if (main === null) return -1;
    return main.getBoundingClientRect().top + parseFloat(getComputedStyle(main).paddingTop);
  });
  // Measured on the header's CONTENT (the cog button), not its box: the old
  // 10px lived as padding inside the box, so the box's own top never moved.
  const cog = await box(page, ".wx-srv-settings-button");
  expect.soft(Math.abs(cog.top - mainTop)).toBeLessThanOrEqual(1); // was 10px lower

  // -- No horizontal overflow at this width ----------------------------------
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect.soft(scrollWidth).toBeLessThanOrEqual(viewportWidth);
});
