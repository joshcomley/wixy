// E2E for the Would-you-rather game (workspace 00045): the whole Server chat is full screen once
// unlocked; starting a round opens a WYR tab (a Chat/WYR tab bar at the bottom) for the starter and
// OFFERS it (with a dot) to the other person; each answers privately; neither sees the other's
// answers until BOTH have pressed Reveal; a skip ends the round for both; tapping the picture flips
// between the two options; the main chat keeps a preview card of every round; and the whole thing
// fits a 360 px phone.
//
// The fixture server runs without a ComfyUI (`WIXY_COMFY_URL` unset), so rounds here are
// text-only: the picture path is covered by the pytest suite with a fake generator.

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

/** Starts a round from the ... menu; the starter lands in the WYR tab. Returns the round's seq. */
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

function game(page: Page): Locator {
  return page.locator(".wx-srv-game");
}

function controls(page: Page): Locator {
  return page.locator(".wx-srv-game-controls");
}

async function press(page: Page, scope: Locator, label: string): Promise<void> {
  await scope.getByRole("button", { name: label, exact: true }).click();
  await humanPause(page);
}

test.describe("Would you rather", () => {
  test("the chat is full screen; two people play a round in the WYR tab: answers stay hidden until both reveal", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errorsA = trackConsoleErrors(pageA);
    const errorsB = trackConsoleErrors(pageB);
    await unlockServer(pageA, "Alice");
    await unlockServer(pageB, "Bob");

    // Full screen: the shell's status bar, top bar and navigation are all gone, and the chat
    // reaches the top of the window.
    for (const selector of [".wx-statusbar", ".wx-topbar", ".wx-nav", ".wx-navrow"]) {
      await expect(pageA.locator(selector)).toBeHidden();
    }
    const panelBox = (await pageA.locator(".wx-srv-panel").boundingBox())!;
    expect(panelBox.y).toBeLessThan(24);
    const viewport = pageA.viewportSize()!;
    expect(panelBox.y + panelBox.height).toBeGreaterThan(viewport.height - 24);
    await expect(pageA.locator(".wx-srv-tabs")).toBeHidden(); // no game, no tabs

    const seq = await startRound(pageA);
    const roundA = pageA.locator(`.wx-srv-bubble-wyr[data-message-seq="${seq}"]`);

    // The starter lands in the WYR tab: tabs at the bottom, the game showing, the thread hidden.
    await expect(pageA.locator(".wx-srv-tabs")).toBeVisible();
    await expect(pageA.locator(".wx-srv-tab-wyr")).toHaveClass(/wx-srv-tab-on/);
    await expect(game(pageA)).toBeVisible();
    await expect(pageA.locator(".wx-srv-thread-wrap")).toBeHidden();
    await expect(controls(pageA)).toContainText("Waiting for the other person");

    // The other person is OFFERED the tab (dot) without being pulled out of the chat, and the
    // main chat holds the round's preview card.
    await eventually([pageA, pageB], async () => (await pageB.locator(".wx-srv-tabs").isVisible()), "Bob is offered the tab");
    await expect(pageB.locator(".wx-srv-tab-wyr .wx-srv-tab-dot")).toBeVisible();
    await expect(game(pageB)).toBeHidden();
    const roundB = pageB.locator(`.wx-srv-bubble-wyr[data-message-seq="${seq}"]`);
    await expect(roundB).toBeVisible();
    await expect(roundB).toContainText("wants to play");
    expect(await roundB.locator(".wx-srv-wyr-group").count()).toBe(0); // the preview has no answer controls

    // Bob opens it from the card's button and joins.
    await roundB.getByRole("button", { name: "Play", exact: true }).click();
    await expect(game(pageB)).toBeVisible();
    await expect(controls(pageB)).toContainText("wants to play");
    await press(pageB, controls(pageB), "Play");

    // Tapping the picture flips between the two options.
    const caption = pageB.locator(".wx-srv-game-caption-text");
    const first = await caption.textContent();
    await pageB.locator(".wx-srv-game-stage").click();
    await humanPause(pageB);
    expect(await caption.textContent()).not.toBe(first);
    await pageB.locator(".wx-srv-game-stage").click();
    await humanPause(pageB);
    expect(await caption.textContent()).toBe(first);

    // Answering: each privately picks and guesses (two segmented choices, then Send).
    await expect(controls(pageA)).toContainText("Which would YOU rather?");
    await expect(controls(pageB)).toContainText("Which would YOU rather?");

    async function answer(page: Page, pick: 0 | 1, guess: 0 | 1): Promise<void> {
      const groups = controls(page).locator(".wx-srv-wyr-group");
      await groups.nth(0).locator("button").nth(pick).click();
      await humanPause(page);
      await groups.nth(1).locator("button").nth(guess).click();
      await humanPause(page);
      await press(page, controls(page), "Send my answer");
    }
    await answer(pageA, 0, 1);
    // Alice answered; Bob has not — nothing about her answer is on Bob's screen.
    await expect(controls(pageA)).toContainText("Your answer is in");
    await expect(controls(pageB).locator(".wx-srv-wyr-result")).toHaveCount(0);
    await answer(pageB, 1, 0);

    // Both answered: Reveal appears for each; still no answers on screen.
    await expect(controls(pageA).getByRole("button", { name: "Reveal", exact: true })).toBeVisible();
    await expect(controls(pageB).getByRole("button", { name: "Reveal", exact: true })).toBeVisible();
    await expect(controls(pageA).locator(".wx-srv-wyr-result")).toHaveCount(0);
    await expect(controls(pageB).locator(".wx-srv-wyr-result")).toHaveCount(0);

    // One reveal is not enough.
    await press(pageA, controls(pageA), "Reveal");
    await expect(controls(pageA)).toContainText("Waiting for Bob to press Reveal");
    const bobReveal = controls(pageB).getByRole("button", { name: /^Tap to reveal together/ });
    await expect(bobReveal).toBeVisible();
    await expect(bobReveal).toContainText("Tap to reveal together");
    await expect(controls(pageB).locator(".wx-srv-wyr-result")).toHaveCount(0);
    await expect(controls(pageA).locator(".wx-srv-wyr-result")).toHaveCount(0);

    // Both revealed: everyone sees both people's picks and guesses.
    await bobReveal.click();
    await humanPause(pageB);
    await eventually([pageA, pageB], async () => (await controls(pageA).locator(".wx-srv-wyr-result").count()) === 2, "Alice sees the result");
    await eventually([pageA, pageB], async () => (await controls(pageB).locator(".wx-srv-wyr-result").count()) === 2, "Bob sees the result");
    await expect(controls(pageA).locator(".wx-srv-wyr-headline")).toBeVisible();
    await expect(controls(pageB)).toContainText("Picked:");
    await expect(pageA.locator(".wx-srv-game-next")).toBeVisible(); // a finished round offers the next
    await pageB.screenshot({ path: test.info().outputPath("b-revealed.png") });

    // Back in the chat, the round's preview card summarises how it went.
    await pageA.locator(".wx-srv-tab-chat").click();
    await expect(pageA.locator(".wx-srv-thread-wrap")).toBeVisible();
    await expect(roundA).toContainText("read each other");

    // It survives a reload (the round is stored, the view re-fetched): no tab for a finished round,
    // the preview card still tells the story.
    await pageB.reload();
    await unlockServer(pageB, "Bob");
    await expect(pageB.locator(".wx-srv-tabs")).toBeHidden();
    await eventually([pageB], async () => (await pageB.locator(`.wx-srv-bubble-wyr[data-message-seq="${seq}"]`).innerText()).includes("read each other"), "Bob's preview card after reload");

    expect(errorsA.filter((e) => !/favicon/i.test(e))).toEqual([]);
    expect(errorsB.filter((e) => !/favicon/i.test(e))).toEqual([]);
    await closeAll(contextA, contextB);
  });

  test("a Skip vote ends the round for both; closing the game removes the tab bar", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await unlockServer(pageA, "Alice");
    await unlockServer(pageB, "Bob");

    const seq = await startRound(pageA);
    await eventually([pageA, pageB], async () => await pageB.locator(`.wx-srv-bubble-wyr[data-message-seq="${seq}"]`).isVisible(), "Bob sees the round");
    await pageB.locator(`.wx-srv-bubble-wyr[data-message-seq="${seq}"]`).getByRole("button", { name: "Play", exact: true }).click();
    await press(pageB, controls(pageB), "Skip");
    await eventually([pageA, pageB], async () => (await controls(pageA).innerText()).includes("Skipped"), "Alice sees it skipped");
    await expect(controls(pageB)).toContainText("Skipped");
    await expect(controls(pageA).getByRole("button", { name: "Play", exact: true })).toHaveCount(0);

    // Closing the game closes the tab; with one tab left the bar disappears and the chat shows.
    await pageA.locator(".wx-srv-game-close").click();
    await expect(pageA.locator(".wx-srv-tabs")).toBeHidden();
    await expect(pageA.locator(".wx-srv-thread-wrap")).toBeVisible();
    await closeAll(contextA, contextB);
  });

  test("the card's chat: mini chat, pop-up with the same composer, also in the main chat (tagged)", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errors = [trackConsoleErrors(pageA), trackConsoleErrors(pageB)];
    await unlockServer(pageA, "Alice");
    await unlockServer(pageB, "Bob");

    async function say(page: Page, text: string): Promise<void> {
      await page.locator(".wx-chat-composer-input").fill(text);
      await page.locator(".wx-chat-send-button").click();
      await humanPause(page);
    }

    const seq = await startRound(pageA);
    await eventually([pageA, pageB], async () => await pageB.locator(`.wx-srv-bubble-wyr[data-message-seq="${seq}"]`).isVisible(), "Bob sees the round");
    await pageB.locator(`.wx-srv-bubble-wyr[data-message-seq="${seq}"]`).getByRole("button", { name: "Play", exact: true }).click();
    await expect(game(pageB)).toBeVisible();

    // A message sent in the WYR tab lands in the OTHER person's mini chat for this card.
    await say(pageA, "I love the first one");
    await eventually([pageA, pageB], async () => (await pageB.locator(".wx-srv-game-mini").innerText()).includes("I love the first one"), "Bob's mini chat");
    await expect(pageA.locator(".wx-srv-game-mini")).toContainText("I love the first one");
    await expect(pageB.locator(".wx-srv-game-mini")).toContainText("Alice:");

    // Only the last two messages show in the mini chat.
    await say(pageA, "second thought");
    await say(pageA, "third thought");
    await eventually([pageA, pageB], async () => (await pageB.locator(".wx-srv-game-mini-msg").count()) === 2, "two mini rows");
    await expect(pageB.locator(".wx-srv-game-mini")).not.toContainText("I love the first one");

    // Tapping a mini-chat message opens the pop-up: the card's whole history, with the composer.
    await pageB.locator(".wx-srv-game-mini-msg").first().click();
    await expect(pageB.locator(".wx-srv-gamepop")).toBeVisible();
    await expect(pageB.locator(".wx-srv-gamepop .wx-srv-bubble")).toHaveCount(3);
    await expect(pageB.locator(".wx-srv-gamepop")).toContainText("I love the first one");
    await expect(pageB.locator(".wx-srv-gamepop .wx-chat-composer-input")).toBeVisible();
    await expect(pageB.locator(".wx-srv-gamepop .wx-srv-bubble-wyrtag").first()).toBeHidden(); // the pop-up is already the game chat
    await pageB.screenshot({ path: test.info().outputPath("b-popup.png") });

    // A reply typed in the pop-up goes to the same card chat.
    await say(pageB, "me too, but the second is closer");
    await expect(pageB.locator(".wx-srv-gamepop .wx-srv-bubble")).toHaveCount(4);
    await eventually([pageA, pageB], async () => (await pageA.locator(".wx-srv-game-mini").innerText()).includes("me too"), "Alice sees the reply");
    await pageB.locator(".wx-srv-gamepop-close").click();
    await expect(pageB.locator(".wx-srv-gamepop")).toBeHidden();
    // The composer is back in the chat, where it always is.
    await expect(pageB.locator(".wx-srv-thread-view > .wx-chat-composer, .wx-srv-thread-view .wx-chat-composer-input").first()).toBeVisible();

    // The Chat tab shows the same messages in the main chat, each tagged WYR; ordinary chat is not tagged
    // and does not appear in the card's mini chat.
    await pageB.locator(".wx-srv-tab-chat").click();
    await expect(pageB.locator(".wx-srv-thread-wrap")).toBeVisible();
    const tagged = pageB.locator(".wx-srv-thread .wx-srv-bubble:has(.wx-srv-bubble-wyrtag)");
    await expect(tagged).toHaveCount(4);
    await say(pageB, "just ordinary chat");
    await expect(pageB.locator(".wx-srv-thread .wx-srv-bubble:has-text('just ordinary chat') .wx-srv-bubble-wyrtag")).toHaveCount(0);
    await eventually([pageA, pageB], async () => (await pageA.locator(".wx-srv-tab-chat .wx-srv-tab-dot").isVisible()), "Alice's Chat tab gets a dot");
    await expect(pageA.locator(".wx-srv-game-mini")).not.toContainText("just ordinary chat");

    // It all survives a reload: the card's chat is stored with the card.
    await pageA.reload();
    await unlockServer(pageA, "Alice");
    await eventually([pageA], async () => await pageA.locator(".wx-srv-tabs").isVisible(), "the round's tab is offered again");
    await pageA.locator(".wx-srv-tab-wyr").click();
    await expect(pageA.locator(".wx-srv-game-mini")).toContainText("me too");
    await expect(pageA.locator(".wx-srv-game-mini")).not.toContainText("just ordinary chat");

    for (const e of errors) expect(e.filter((m) => !/favicon/i.test(m))).toEqual([]);
    await closeAll(contextA, contextB);
  });

  test("the game fits a 360 px phone with real tap targets", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 780 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await unlockServer(page, "Alice");
    await startRound(page);
    await expect(game(page)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("phone-voting.png") });

    // Nothing overflows sideways.
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(pageOverflow).toBeLessThanOrEqual(1);
    const paneFit = await game(page).evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(paneFit.scroll).toBeLessThanOrEqual(paneFit.client + 1);

    // The picture area keeps real room even with the controls, the mini chat, the composer and the
    // tab bar all on screen; each of those is inside the viewport and a proper tap target.
    const stage = (await page.locator(".wx-srv-game-stage").boundingBox())!;
    expect(stage.height).toBeGreaterThanOrEqual(140);
    expect(stage.x).toBeGreaterThanOrEqual(0);
    expect(stage.x + stage.width).toBeLessThanOrEqual(360.5);
    for (const selector of [".wx-srv-game-mini", ".wx-chat-composer-input", ".wx-srv-tab-chat", ".wx-srv-tab-wyr"]) {
      const box = (await page.locator(selector).first().boundingBox())!;
      expect(box, selector).not.toBeNull();
      expect(box.y + box.height, `${selector} bottom`).toBeLessThanOrEqual(780.5);
      expect(box.x, `${selector} left`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${selector} right`).toBeLessThanOrEqual(360.5);
    }
    for (const selector of [".wx-srv-tab-chat", ".wx-srv-tab-wyr", ".wx-srv-game-close"]) {
      const box = (await page.locator(selector).boundingBox())!;
      expect(box.height, `${selector} height`).toBeGreaterThanOrEqual(43.5);
    }
    // The tab bar is what a tap at its centre hits (not hidden behind anything).
    const hit = await page.locator(".wx-srv-tab-chat").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top !== null && (top === el || el.contains(top));
    });
    expect(hit).toBe(true);
    // The game header (title, Topics, close; Next appears later) stays inside the phone.
    for (const selector of [".wx-srv-game-topics", ".wx-srv-game-close"]) {
      const box = (await page.locator(selector).boundingBox())!;
      expect(box.x + box.width, `${selector} right`).toBeLessThanOrEqual(360.5);
      expect(box.height, `${selector} height`).toBeGreaterThanOrEqual(43.5);
    }
    await context.close();
  });

  test("topics: pick only some, start a round, and the screen fits a 360 px phone", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 780 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await unlockServer(page, "Alice");

    await page.locator(".wx-srv-more-button").click();
    await humanPause(page);
    await page.locator(".wx-srv-more-topics").click();
    const topics = page.locator(".wx-srv-topics-view");
    await expect(topics).toBeVisible();
    await expect(page.locator(".wx-srv-topics-box")).not.toHaveCount(0);

    // Unselect all: nothing can be saved until at least one topic is ticked.
    await page.locator(".wx-srv-topics-none").click();
    await humanPause(page);
    await expect(page.locator(".wx-srv-topics-save")).toBeDisabled();
    const food = page.locator(".wx-srv-topics-row", { hasText: "Food: meals" });
    await food.locator(".wx-srv-topics-box").check();
    await humanPause(page);
    await expect(page.locator(".wx-srv-topics-save")).toBeEnabled();
    await page.locator(".wx-srv-topics-save").click();
    await expect(page.locator(".wx-srv-topics-status")).toContainText("Saved");

    // Nothing overflows sideways and every row is a real tap target.
    const fit = await topics.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(fit.scroll).toBeLessThanOrEqual(fit.client + 1);
    const row = (await food.boundingBox())!;
    expect(row.height).toBeGreaterThanOrEqual(43.5);
    expect(row.x + row.width).toBeLessThanOrEqual(360.5);
    await page.screenshot({ path: test.info().outputPath("phone-topics.png") });

    // A round still starts with a topic chosen (which topic each round draws from is pytest's job).
    await page.locator(".wx-srv-topics-close").click();
    await expect(topics).toBeHidden();
    await humanPause(page);
    await startRound(page);
    await expect(game(page)).toBeVisible();

    // Reset to every topic so later specs on this shared fixture server are unaffected.
    await page.locator(".wx-srv-game-topics").click();
    await expect(page.locator(".wx-srv-topics-box")).not.toHaveCount(0);
    await humanPause(page);
    await page.locator(".wx-srv-topics-all").click();
    await humanPause(page);
    await page.locator(".wx-srv-topics-save").click();
    await expect(page.locator(".wx-srv-topics-status")).toContainText("Saved");
    await context.close();
  });
});
