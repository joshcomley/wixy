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
import { unlockTogether } from "./two-devices";

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
    await unlockTogether(unlockServer, [[pageA, "Alice"], [pageB, "Bob"]]);

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
    await unlockTogether(unlockServer, [[pageA, "Alice"], [pageB, "Bob"]]);

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

  test("the card's chat: FAB pop-up, floating message, quick reply, also in the main chat (tagged)", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errors = [trackConsoleErrors(pageA), trackConsoleErrors(pageB)];
    await unlockTogether(unlockServer, [[pageA, "Alice"], [pageB, "Bob"]]);

    async function say(page: Page, text: string): Promise<void> {
      await page.locator(".wx-chat-composer-input").fill(text);
      await page.locator(".wx-chat-send-button").click();
      await humanPause(page);
    }
    const fab = (page: Page) => page.locator(".wx-srv-game .wx-srv-float-fab");
    const floating = (page: Page) => page.locator(".wx-srv-game .wx-srv-float-bubble");

    const seq = await startRound(pageA);
    await eventually([pageA, pageB], async () => await pageB.locator(`.wx-srv-bubble-wyr[data-message-seq="${seq}"]`).isVisible(), "Bob sees the round");
    await pageB.locator(`.wx-srv-bubble-wyr[data-message-seq="${seq}"]`).getByRole("button", { name: "Play", exact: true }).click();
    await expect(game(pageB)).toBeVisible();

    // The game runs FULL SCREEN: no chat header, no composer — until the FAB's pop-up borrows it.
    await expect(pageA.locator(".wx-srv-thread-header")).toBeHidden();
    await expect(pageA.locator(".wx-srv-thread-view > .wx-chat-composer")).toBeHidden();
    await expect(fab(pageA)).toHaveAttribute("aria-label", "Open this card's chat");

    // Alice writes in the card's pop-up (the FAB opens it). The message FLOATS on Bob's screen and dots his FAB.
    await fab(pageA).click();
    await expect(pageA.locator(".wx-srv-gamepop .wx-chat-composer-input")).toBeVisible();
    await say(pageA, "I love the first one");
    await expect(pageA.locator(".wx-srv-gamepop .wx-srv-bubble")).toHaveCount(1);
    await pageA.locator(".wx-srv-gamepop-close").click();
    await expect(pageA.locator(".wx-srv-gamepop")).toBeHidden();
    await expect(floating(pageB)).toContainText("I love the first one", { timeout: 20_000 });
    await expect(floating(pageB)).toContainText("Alice:");
    await expect(fab(pageB)).toHaveAttribute("aria-label", /new message/);
    await expect(pageB.locator(".wx-srv-game .wx-srv-float-dot")).toBeVisible();
    await pageB.screenshot({ path: test.info().outputPath("b-floating.png") });

    // Tapping it opens the quick reply (the same composer, the mic, Send); the answer goes to THIS card's
    // chat, the box closes, and the dot is gone. It floats on Alice's screen.
    await humanPause(pageB);
    await pageB.locator(".wx-srv-game .wx-srv-float-open").click();
    await expect(pageB.locator(".wx-srv-quick")).toBeVisible();
    await expect(pageB.locator(".wx-srv-quick .wx-chat-composer-input")).toBeVisible();
    await expect(pageB.locator(".wx-srv-quick .wx-srv-record-button, .wx-srv-quick [aria-label*='oice']").first()).toBeVisible();
    await expect(pageB.locator(".wx-srv-game .wx-srv-float-dot")).toBeHidden();
    await pageB.screenshot({ path: test.info().outputPath("b-quick-reply.png") });
    await say(pageB, "me too, but the second is closer");
    await expect(pageB.locator(".wx-srv-quick")).toBeHidden();
    await expect(floating(pageA)).toContainText("me too", { timeout: 20_000 });

    // The pop-up (the FAB) is the card's whole history, with the composer; it is already the game chat, so no tag.
    await humanPause(pageA);
    await fab(pageA).click();
    await expect(pageA.locator(".wx-srv-gamepop .wx-srv-bubble")).toHaveCount(2);
    await expect(pageA.locator(".wx-srv-gamepop")).toContainText("I love the first one");
    await expect(pageA.locator(".wx-srv-gamepop")).toContainText("me too");
    await expect(pageA.locator(".wx-srv-gamepop .wx-srv-bubble-wyrtag").first()).toBeHidden();
    await expect(fab(pageA)).toHaveAttribute("aria-label", "Open this card's chat"); // seen: no dot
    await pageA.locator(".wx-srv-gamepop-close").click();
    await expect(pageA.locator(".wx-srv-gamepop")).toBeHidden();

    // The Chat tab brings the header and the composer back, and shows the same messages in the main chat,
    // each tagged WYR; ordinary chat is not tagged and does not appear in the card's pop-up.
    await pageB.locator(".wx-srv-tab-chat").click();
    await expect(pageB.locator(".wx-srv-thread-wrap")).toBeVisible();
    await expect(pageB.locator(".wx-srv-thread-header")).toBeVisible();
    await expect(pageB.locator(".wx-srv-thread-view > .wx-chat-composer")).toBeVisible();
    const tagged = pageB.locator(".wx-srv-thread .wx-srv-bubble:has(.wx-srv-bubble-wyrtag)");
    await expect(tagged).toHaveCount(2);
    await say(pageB, "just ordinary chat");
    await expect(pageB.locator(".wx-srv-thread .wx-srv-bubble:has-text('just ordinary chat') .wx-srv-bubble-wyrtag")).toHaveCount(0);

    // Alice is in the WYR tab: Chat gets its dot AND the main-chat message floats, labelled "Chat". A quick
    // reply to it goes to the MAIN chat (not the card's).
    await eventually([pageA, pageB], async () => (await pageA.locator(".wx-srv-tab-chat .wx-srv-tab-dot").isVisible()), "Alice's Chat tab gets a dot");
    await expect(floating(pageA)).toContainText("just ordinary chat");
    await expect(floating(pageA).locator(".wx-srv-float-tag")).toBeVisible();
    await expect(fab(pageA)).toHaveAttribute("aria-label", "Open this card's chat"); // the dot is for the card's own chat
    await humanPause(pageA);
    await pageA.locator(".wx-srv-game .wx-srv-float-open").click();
    await expect(pageA.locator(".wx-srv-quick")).toBeVisible();
    await say(pageA, "heard you in the main chat");
    await expect(pageA.locator(".wx-srv-quick")).toBeHidden();
    await expect(pageB.locator(".wx-srv-thread .wx-srv-bubble:has-text('heard you in the main chat')")).toBeVisible({ timeout: 20_000 });
    await expect(pageB.locator(".wx-srv-thread .wx-srv-bubble:has-text('heard you in the main chat') .wx-srv-bubble-wyrtag")).toHaveCount(0);

    // It all survives a reload: the card's chat is stored with the card.
    await pageA.reload();
    await unlockServer(pageA, "Alice");
    await eventually([pageA], async () => await pageA.locator(".wx-srv-tabs").isVisible(), "the round's tab is offered again");
    await pageA.locator(".wx-srv-tab-wyr").click();
    await humanPause(pageA);
    await fab(pageA).click();
    await expect(pageA.locator(".wx-srv-gamepop")).toContainText("me too");
    await expect(pageA.locator(".wx-srv-gamepop")).not.toContainText("just ordinary chat");

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

    // The game is full screen (no chat header, no composer). The picture area keeps real room even with the
    // controls, the chat FAB and the tab bar all on screen; each of those is inside the viewport.
    await expect(page.locator(".wx-srv-thread-header")).toBeHidden();
    const stage = (await page.locator(".wx-srv-game-stage").boundingBox())!;
    expect(stage.height).toBeGreaterThanOrEqual(140);
    expect(stage.x).toBeGreaterThanOrEqual(0);
    expect(stage.x + stage.width).toBeLessThanOrEqual(360.5);
    for (const selector of [".wx-srv-game-head", ".wx-srv-game .wx-srv-float-fab", ".wx-srv-tab-chat", ".wx-srv-tab-wyr"]) {
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

  test("a finished round with chat stays tidy on a phone: nothing overlaps, the floating message and FAB sit in their own row", async ({ browser }) => {
    // Operator report (2026-10-20): after a reveal, with two chat messages, the chat rows overlapped the
    // composer and its expand button floated loose. The strip and the composer are gone from a game tab now
    // (decisions/00193): the same guarantee is that the floating message and the FAB never overlap the game.
    const phone = { viewport: { width: 362, height: 740 }, hasTouch: true, isMobile: true };
    const contextA = await browser.newContext(phone);
    const contextB = await browser.newContext(phone);
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await unlockTogether(unlockServer, [[pageA, "Cupcake"], [pageB, "Bubble"]]);

    const seq = await startRound(pageA);
    await eventually([pageA, pageB], async () => await pageB.locator(`.wx-srv-bubble-wyr[data-message-seq="${seq}"]`).isVisible(), "Bubble sees the round");
    await pageB.locator(`.wx-srv-bubble-wyr[data-message-seq="${seq}"]`).getByRole("button", { name: "Play", exact: true }).click();
    await humanPause(pageB);
    await expect(game(pageB)).toBeVisible();
    await press(pageB, controls(pageB), "Play");
    await eventually([pageA, pageB], async () => (await controls(pageA).locator(".wx-srv-wyr-group").count()) === 2, "Cupcake can answer");
    for (const page of [pageA, pageB]) {
      const groups = controls(page).locator(".wx-srv-wyr-group");
      await groups.nth(0).locator("button").nth(1).click();
      await humanPause(page);
      await groups.nth(1).locator("button").nth(1).click();
      await humanPause(page);
      await press(page, controls(page), "Send my answer");
    }
    await eventually([pageA, pageB], async () => await controls(pageA).getByRole("button", { name: "Reveal", exact: true }).isVisible(), "reveal offered");
    await press(pageA, controls(pageA), "Reveal");
    const bobReveal = controls(pageB).getByRole("button", { name: /^Tap to reveal together/ });
    await eventually([pageA, pageB], async () => await bobReveal.isVisible(), "Bubble can reveal");
    await bobReveal.click();
    await humanPause(pageB);
    await eventually([pageA, pageB], async () => (await controls(pageA).locator(".wx-srv-wyr-result").count()) === 2, "result shown");

    // Cupcake writes two messages (the second one long) through the card's pop-up; they float on Bubble's phone.
    await pageA.locator(".wx-srv-game .wx-srv-float-fab").click();
    for (const text of ["Yay!", "Forttttttt — and a much longer second message that has to wrap or be cut neatly"]) {
      await pageA.locator(".wx-chat-composer-input").fill(text);
      await pageA.locator(".wx-chat-send-button").click();
      await humanPause(pageA);
    }
    await pageA.locator(".wx-srv-gamepop-close").click();
    const floating = pageB.locator(".wx-srv-game .wx-srv-float-bubble");
    await expect(floating).toContainText("Forttttttt", { timeout: 20_000 });
    await expect(floating.locator(".wx-srv-float-more")).toHaveText("+1");
    await pageB.screenshot({ path: test.info().outputPath("phone-revealed-chat.png") });

    const boxOf = async (selector: string) => (await pageB.locator(selector).first().boundingBox())!;
    const order = [".wx-srv-game-head", ".wx-srv-game-stage", ".wx-srv-game-controls", ".wx-srv-game-chatrow", ".wx-srv-tabs"];
    const boxes = [];
    for (const selector of order) {
      const box = await boxOf(selector);
      expect(box, selector).not.toBeNull();
      expect(box.x, `${selector} left`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${selector} right`).toBeLessThanOrEqual(362.5);
      expect(box.y + box.height, `${selector} bottom`).toBeLessThanOrEqual(740.5);
      boxes.push({ selector, box });
    }
    for (let i = 1; i < boxes.length; i += 1) {
      const above = boxes[i - 1]!;
      const below = boxes[i]!;
      expect(below.box.y, `${below.selector} starts below ${above.selector}`).toBeGreaterThanOrEqual(above.box.y + above.box.height - 0.5);
    }
    // The picture keeps real room.
    expect((await boxOf(".wx-srv-game-stage")).height).toBeGreaterThanOrEqual(120);
    // The floating message and the FAB sit inside the reserved chat row, side by side, the message clamped.
    const row = await boxOf(".wx-srv-game-chatrow");
    const bubble = await boxOf(".wx-srv-game .wx-srv-float-bubble");
    const fabBox = await boxOf(".wx-srv-game .wx-srv-float-fab");
    for (const [name, box] of [["bubble", bubble], ["fab", fabBox]] as const) {
      expect(box.y, `${name} top`).toBeGreaterThanOrEqual(row.y - 0.5);
      expect(box.y + box.height, `${name} bottom`).toBeLessThanOrEqual(row.y + row.height + 0.5);
    }
    expect(bubble.x + bubble.width).toBeLessThanOrEqual(fabBox.x + 0.5);
    expect(bubble.height).toBeLessThanOrEqual(64.5);
    expect(fabBox.width).toBeGreaterThanOrEqual(43.5);
    expect(fabBox.height).toBeGreaterThanOrEqual(43.5);
    await closeAll(contextA, contextB);
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
