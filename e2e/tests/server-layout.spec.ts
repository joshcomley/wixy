// Phone layout of the Server chat (operator report, 2026-09-25): the message
// card sat 12px further in from the screen edge than the composer row, the
// composer's controls were four different heights/tops, and there was ~26px
// of dead space above the first message plus ~22px between the tab strip and
// the Server header. Real geometry only — jsdom cannot lay anything out — at
// the operator's phone width (CSS 402px). Tolerances are 1px (sub-pixel
// rounding); the fixes bring every figure below to an exact match.

import { expect, test } from "../fixtures";
import type { Page } from "@playwright/test";

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

/** A locator's `.evaluate()` re-resolves fresh each call, so it never reads a
 * detached/stale element - but it can catch a bubble mid-render: thread.ts
 * (`renderEchoBubble` / `renderThreadList`) swaps the optimistic echo for the
 * server-confirmed message, and for one frame either the new node hasn't been
 * laid out yet or a transitional element with the same class briefly matches
 * `.last()`, both reading back as a zero rect (`left/right/width` all 0).
 * Poll for a genuinely laid-out box - width > 0, and unchanged across two
 * reads - instead of trusting the first one. */
async function stableBox(page: Page, locator: ReturnType<Page["locator"]>): Promise<Box> {
  let previous: Box | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = await locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    });
    if (current.width > 0 && previous !== null && JSON.stringify(current) === JSON.stringify(previous)) {
      return current;
    }
    previous = current;
    await page.waitForTimeout(100);
  }
  if (previous === null) throw new Error("stableBox: locator never resolved");
  return previous;
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

  // -- 5. Bubble rhythm + alignment ------------------------------------------
  // `.wx-srv-message-list` must be a flex column: as a plain block, consecutive
  // bubbles touched and `align-self` (own messages right, theirs left) did
  // nothing, so every bubble sat on the left.
  const adjacentBubbleGap = await page.evaluate(() => {
    const bubbles = Array.from(document.querySelectorAll<HTMLElement>(".wx-srv-message-list > .wx-srv-bubble"));
    for (const bubble of bubbles) {
      const next = bubble.nextElementSibling;
      if (next instanceof HTMLElement && next.classList.contains("wx-srv-bubble")) {
        return next.getBoundingClientRect().top - bubble.getBoundingClientRect().bottom;
      }
    }
    return -1;
  });
  expect.soft(adjacentBubbleGap, "two bubbles in a row have a visible gap").toBeGreaterThanOrEqual(6);

  await page.mouse.move(40, 40);
  await page.locator(".wx-chat-composer-input").fill("Layout probe reply");
  await page.locator(".wx-chat-send-button").click();
  const mine = page.locator(".wx-srv-bubble-mine").last();
  await expect(mine).toBeVisible();
  const cardNow = await box(page, ".wx-srv-thread");
  const mineBox = await stableBox(page, mine);
  const theirsBox = await stableBox(page, page.locator(".wx-srv-bubble-theirs").first());
  // Card border (1px) + padding (12px) on each side.
  expect.soft(Math.abs(mineBox.right - (cardNow.right - 13)), "own bubble hugs the right edge").toBeLessThanOrEqual(1);
  expect.soft(Math.abs(theirsBox.left - (cardNow.left + 13)), "their bubble hugs the left edge").toBeLessThanOrEqual(1);

  // -- No horizontal overflow at this width ----------------------------------
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect.soft(scrollWidth).toBeLessThanOrEqual(viewportWidth);
});

// commit 9a8d8be made `.wx-srv-bubble-theirs`'s pre-existing `align-self:
// flex-start` actually take effect (the message list became a real flex
// column), so a short incoming bubble now shrink-wraps to its content
// instead of always being ~80% of the card wide. `.wx-srv-message-actions`
// (the right-click/long-press menu) was already unconditionally anchored
// 10rem (160px) LEFTWARD of the bubble's own right edge — invisible while
// bubbles were always wide, but a short bubble's right edge can now be well
// under 160px from the card's left edge, pushing the whole menu off-screen
// with no scroll to reach it (chat.css's `.wx-srv-bubble-theirs
// .wx-srv-message-actions` override fixes it). 320px and 402px (the
// operator's phone) — the narrowest widths this admin supports.
for (const width of [320, 402]) {
  test(`message actions menu on a short incoming bubble stays on-screen at ${width}px`, async ({ page }) => {
    // The WIDTH is what this test verifies (the horizontal anchor fix); the
    // HEIGHT is deliberately generous and not part of what's under test. This
    // file shares ONE fixture server/thread across every test in it
    // (playwright.config.ts's own convention: `workers: 1`, no per-test
    // reset), so by the time this runs the thread already holds earlier
    // tests' history and the newest message - the one whose menu this test
    // opens - can sit flush against the thread's own scroll bottom, leaving
    // no room for the menu (anchored to the bubble's top, growing downward)
    // to lay out below it. That is the THREAD's own `overflow-y:auto`
    // clipping it - a confound unrelated to the browser-viewport anchor bug
    // this test targets. A tall viewport (`.wx-srv-panel`'s `min-height:
    // 60vh` scales the thread with it) keeps that confound out of the way
    // without touching app state.
    await page.setViewportSize({ width, height: 1600 });
    await unlockServer(page, "Cupcake");

    // A label unique to THIS test (the file's own established convention,
    // e.g. server-chat.spec.ts): the sibling width's run seeds the same
    // generic text otherwise, and a bare locator could resolve either bubble
    // once both exist in the shared thread.
    const label = `ok${width}`;
    await page.request.post("/test/server/seed-messages", {
      data: { count: 1, label, sender: "Fixture", startAgoS: 60, spreadS: 0 },
    });
    const bubble = page.locator(".wx-srv-bubble-theirs", { hasText: `${label} #1` });
    await expect(bubble).toBeVisible({ timeout: 5000 });
    await bubble.scrollIntoViewIfNeeded();
    await bubble.hover();
    await bubble.locator(".wx-srv-message-actions-trigger").click();
    const menu = bubble.locator(".wx-srv-message-actions");
    await expect(menu).toBeVisible();
    await page.waitForTimeout(150);

    const menuBox = await menu.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right };
    });
    expect(menuBox.left, "menu's left edge is on-screen").toBeGreaterThanOrEqual(0);
    expect(menuBox.right, `menu's right edge is within the ${width}px viewport`).toBeLessThanOrEqual(width);

    // Every item must actually be reachable, not merely inside the box on paper.
    const items = menu.locator('[role="menuitem"]');
    const itemCount = await items.count();
    expect(itemCount, "the menu has at least one action").toBeGreaterThan(0);
    for (let i = 0; i < itemCount; i++) {
      await expect(items.nth(i)).toBeInViewport();
    }
  });
}
