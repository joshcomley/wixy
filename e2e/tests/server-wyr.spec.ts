// E2E for the Would-you-rather game (workspace 00045): two people, one starts a round from the
// header's ... menu; the other joins; each answers privately; neither sees the other's answers
// until BOTH have pressed Reveal; a skip ends the round for both; and the card fits a 360 px phone.
//
// The fixture server runs without a ComfyUI (`WIXY_COMFY_URL` unset), so rounds here are
// text-only: the image path is covered by the pytest suite with a fake generator.

import { expect, test } from "../fixtures";
import type { BrowserContext, Locator, Page } from "@playwright/test";
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
  // Two taps less than 400ms apart lock the chat (R3): let that window pass.
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

async function humanPause(page: Page): Promise<void> {
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

/** A light touch so R7's 10s idle lock never fires on a page a test is only watching. */
async function keepAlive(page: Page): Promise<void> {
  await page.mouse.move(3 + Math.random() * 4, 3 + Math.random() * 4);
}

async function eventually(pages: readonly Page[], check: () => Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    for (const page of pages) await keepAlive(page);
    await pages[0]!.waitForTimeout(150);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

async function closeAll(...contexts: BrowserContext[]): Promise<void> {
  for (const context of contexts) await context.close();
}

/** Starts a round from the ... menu and returns the seq of its message. */
async function startRound(page: Page): Promise<string> {
  const before = await page.locator(".wx-srv-bubble-wyr").count();
  await page.locator(".wx-srv-more-button").click();
  await expect(page.locator(".wx-srv-more-wyr")).toBeVisible();
  await humanPause(page);
  await page.locator(".wx-srv-more-wyr").click();
  await expect(page.locator(".wx-srv-bubble-wyr")).toHaveCount(before + 1);
  const bubble = page.locator(".wx-srv-bubble-wyr").last();
  const seq = await bubble.getAttribute("data-message-seq");
  expect(seq).not.toBeNull();
  return seq!;
}

function card(page: Page, seq: string): Locator {
  return page.locator(`.wx-srv-bubble-wyr[data-message-seq="${seq}"] .wx-srv-wyr-card`);
}

async function press(page: Page, scope: Locator, label: string): Promise<void> {
  await scope.getByRole("button", { name: label, exact: true }).click();
  await humanPause(page);
}

test.describe("Would you rather", () => {
  test("two people play a round: answers stay hidden until both reveal", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errorsA = trackConsoleErrors(pageA);
    const errorsB = trackConsoleErrors(pageB);
    await unlockServer(pageA, "Alice");
    await unlockServer(pageB, "Bob");

    const seq = await startRound(pageA);
    const cardA = card(pageA, seq);
    const cardB = card(pageB, seq);
    await eventually([pageA, pageB], async () => (await cardB.count()) === 1, "Bob sees the round");

    // Voting: Bob is asked to play; Alice (who started it) waits.
    await expect(cardB).toContainText("wants to play");
    await expect(cardA).toContainText("Waiting for the other person");
    await press(pageB, cardB, "Play");

    // Answering: each privately picks and guesses.
    await expect(cardA).toContainText("Which would YOU rather?");
    await expect(cardB).toContainText("Which would YOU rather?");

    async function answer(page: Page, scope: Locator, pick: 0 | 1, guess: 0 | 1): Promise<void> {
      const groups = scope.locator(".wx-srv-wyr-group");
      await groups.nth(0).locator("button").nth(pick).click();
      await humanPause(page);
      await groups.nth(1).locator("button").nth(guess).click();
      await humanPause(page);
      await press(page, scope, "Send my answer");
    }
    await answer(pageA, cardA, 0, 1);
    // Alice answered; Bob has not — nothing about her answer is on Bob's screen.
    await expect(cardA).toContainText("Your answer is in");
    await expect(cardB.locator(".wx-srv-wyr-result")).toHaveCount(0);
    await answer(pageB, cardB, 1, 0);

    // Both answered: Reveal appears for each; still no answers on screen.
    await expect(cardA.getByRole("button", { name: "Reveal", exact: true })).toBeVisible();
    await expect(cardB.getByRole("button", { name: "Reveal", exact: true })).toBeVisible();
    await expect(cardA.locator(".wx-srv-wyr-result")).toHaveCount(0);
    await expect(cardB.locator(".wx-srv-wyr-result")).toHaveCount(0);

    // One reveal is not enough.
    await press(pageA, cardA, "Reveal");
    await expect(cardA).toContainText("Waiting for Bob to press Reveal");
    await eventually([pageA, pageB], async () => (await cardB.getByRole("button", { name: "Reveal", exact: true }).count()) === 1, "Bob still can reveal");
    await expect(cardB.locator(".wx-srv-wyr-result")).toHaveCount(0);
    await expect(cardA.locator(".wx-srv-wyr-result")).toHaveCount(0);

    // Both revealed: everyone sees both people's picks and guesses.
    await press(pageB, cardB, "Reveal");
    await eventually([pageA, pageB], async () => (await cardA.locator(".wx-srv-wyr-result").count()) === 2, "Alice sees the result");
    await eventually([pageA, pageB], async () => (await cardB.locator(".wx-srv-wyr-result").count()) === 2, "Bob sees the result");
    await expect(cardA.locator(".wx-srv-wyr-headline")).toBeVisible();
    await expect(cardB).toContainText("Picked:");
    await pageB.screenshot({ path: test.info().outputPath("b-revealed.png") });

    // It survives a reload (the round is stored, the view re-fetched).
    await pageB.reload();
    await unlockServer(pageB, "Bob");
    await eventually([pageB], async () => (await card(pageB, seq).locator(".wx-srv-wyr-result").count()) === 2, "Bob's result after reload");

    expect(errorsA.filter((e) => !/favicon/i.test(e))).toEqual([]);
    expect(errorsB.filter((e) => !/favicon/i.test(e))).toEqual([]);
    await closeAll(contextA, contextB);
  });

  test("a Skip vote ends the round for both", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await unlockServer(pageA, "Alice");
    await unlockServer(pageB, "Bob");

    const seq = await startRound(pageA);
    const cardA = card(pageA, seq);
    const cardB = card(pageB, seq);
    await eventually([pageA, pageB], async () => (await cardB.count()) === 1, "Bob sees the round");
    await press(pageB, cardB, "Skip");
    await eventually([pageA, pageB], async () => (await cardA.getAttribute("data-wyr-state")) === "skipped", "Alice sees it skipped");
    await expect(cardB).toContainText("Skipped");
    await expect(cardA.getByRole("button", { name: "Play", exact: true })).toHaveCount(0);
    await closeAll(contextA, contextB);
  });

  test("the card fits a 360 px phone with real tap targets", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 780 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await unlockServer(page, "Alice");
    const seq = await startRound(page);
    const scope = card(page, seq);
    await expect(scope).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("phone-voting.png") });
    const fits = await scope.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(fits.scroll).toBeLessThanOrEqual(fits.client + 1);
    const box = (await scope.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360.5);
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(pageOverflow).toBeLessThanOrEqual(1);
    await context.close();
  });
});
