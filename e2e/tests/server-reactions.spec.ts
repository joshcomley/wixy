// E2E for reactions on Server chat messages (spec/server-chat/04-reactions.md): two people
// reacting live, the menu's emoji row on desktop and on a phone, and — in a real browser,
// where the trap is real — a reaction must never cut off a voice note someone is playing.
//
// One fixture server for the whole run (`workers: 1`, no per-test reset), so every message here
// carries a label unique to its own test rather than asserting a thread-wide count.

import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { trackConsoleErrors } from "./helpers";

test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});
test.describe.configure({ timeout: 90_000 });

/** Mirrors `MULTI_TAP_INTERVAL_MS` in admin-ui/src/server/constants.ts. */
const MULTI_TAP_INTERVAL_MS = 400;

const THUMBS_UP = "\u{1F44D}";
const HEART = "❤️";
const PRAY = "\u{1F64F}";

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

  await expect(page.locator(".wx-srv-name-prompt:visible, .wx-srv-thread:visible")).toBeVisible({
    timeout: 5000,
  });
  if (await page.locator(".wx-srv-name-prompt").isVisible()) {
    await page.locator(".wx-srv-name-prompt-input").fill(name);
    await page.locator(".wx-srv-name-prompt-button").click();
  }
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await expect(page.locator(".wx-srv-name-prompt")).toBeHidden();
  // Two taps less than 400ms apart lock the chat (R3): let that window pass, so the tests
  // exercise a human cadence rather than the panic gesture.
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

async function seed(page: Page, opts: { label: string; sender: string; count?: number }): Promise<void> {
  await page.request.post("/test/server/seed-messages", {
    data: { count: 1, spreadS: 0, ...opts },
  });
}

/** A real device isn't perfectly still for R7's 10s idle window while a test drives a second,
 * slower context: a light touch keeps the page from locking under an assertion. */
async function keepAlive(page: Page): Promise<void> {
  await page.mouse.move(Math.random() * 100, Math.random() * 100);
}

async function waitVisible(locator: Locator, keepAlivePage: Page): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await keepAlive(keepAlivePage);
    if (await locator.first().isVisible().catch(() => false)) return;
    await keepAlivePage.waitForTimeout(500);
  }
  await expect(locator).toBeVisible({ timeout: 3000 });
}

function bubbleWith(page: Page, text: string): Locator {
  return page.locator(".wx-srv-bubble").filter({ hasText: text });
}

function chip(bubble: Locator, emoji: string): Locator {
  return bubble.locator(`.wx-srv-reaction-chip[data-reaction="${emoji}"]`);
}

/** Desktop: hover, open the ⋯ menu, tick one emoji in its reaction row — at full speed, so a
 * regression in the gesture-boundary markers would trip the double-tap lock as it would for a user. */
async function reactFromMenu(bubble: Locator, name: string): Promise<void> {
  await bubble.hover();
  await bubble.locator(".wx-srv-message-actions-trigger").click();
  await bubble.getByRole("menuitemcheckbox", { name }).click();
}

async function closeAll(...contexts: BrowserContext[]): Promise<void> {
  for (const context of contexts) await context.close();
}

test.describe("server-reactions.spec.ts", () => {
  test("two people react live: add from the menu, add to the same emoji, remove, on both screens", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errorsA = trackConsoleErrors(pageA);
    const errorsB = trackConsoleErrors(pageB);
    const label = `react-live-${Date.now()}`;

    await seed(pageA, { label, sender: "Purdy" });
    await unlockServer(pageA, "Josh");
    await unlockServer(pageB, "Purdy");
    const bubbleA = bubbleWith(pageA, `${label} #1`);
    const bubbleB = bubbleWith(pageB, `${label} #1`);
    await waitVisible(bubbleA, pageA);
    await waitVisible(bubbleB, pageB);
    await expect(bubbleA.locator(".wx-srv-reactions")).toBeHidden();

    // Josh adds a thumbs-up from the menu; both screens show it, only Josh's is "mine".
    await reactFromMenu(bubbleA, "Thumbs up");
    await expect(chip(bubbleA, THUMBS_UP)).toHaveText(/1/, { timeout: 3000 });
    await expect(chip(bubbleA, THUMBS_UP)).toHaveAttribute("aria-pressed", "true");
    await waitVisible(chip(bubbleB, THUMBS_UP), pageB);
    await expect(chip(bubbleB, THUMBS_UP)).toHaveText(/1/);
    await expect(chip(bubbleB, THUMBS_UP)).toHaveAttribute("aria-pressed", "false");
    await expect(chip(bubbleB, THUMBS_UP)).toHaveAttribute("title", "Josh");
    // The double-tap lock did not fire on that full-speed menu flow.
    await expect(pageA.locator(".wx-srv-thread")).toBeVisible();

    // Purdy taps the chip: the same emoji now counts two, on both screens.
    await keepAlive(pageA);
    await chip(bubbleB, THUMBS_UP).click();
    await expect(chip(bubbleB, THUMBS_UP)).toHaveText(/2/, { timeout: 3000 });
    await expect(chip(bubbleB, THUMBS_UP)).toHaveAttribute("aria-pressed", "true");
    await waitVisible(chip(bubbleA, THUMBS_UP).filter({ hasText: "2" }), pageA);
    await expect(chip(bubbleA, THUMBS_UP)).toHaveAttribute("title", "Josh, Purdy");

    // A second emoji, from the menu again, sits after the first in list order. Tapping a chip
    // and then ⋯ are independent decisions, so keep a human gap between them (decision 00148):
    // inside 400ms the pair is the double-tap lock, by design.
    await keepAlive(pageB);
    await pageB.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
    await reactFromMenu(bubbleB, "Folded hands");
    await expect(bubbleB.locator(".wx-srv-reaction-chip")).toHaveCount(2, { timeout: 3000 });
    await expect(bubbleB.locator(".wx-srv-reaction-chip").nth(1)).toHaveAttribute("data-reaction", PRAY);

    // Josh taps HIS chip to take his thumbs-up back: it drops to one for both.
    await keepAlive(pageA);
    await pageA.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
    await chip(bubbleA, THUMBS_UP).click();
    await expect(chip(bubbleA, THUMBS_UP)).toHaveText(/1/, { timeout: 3000 });
    await expect(chip(bubbleA, THUMBS_UP)).toHaveAttribute("aria-pressed", "false");
    await waitVisible(chip(bubbleB, THUMBS_UP).filter({ hasText: "1" }), pageB);

    // A reload shows the reactions from history, not only from the live stream.
    await pageB.reload();
    await unlockServer(pageB, "Purdy");
    await waitVisible(bubbleWith(pageB, `${label} #1`), pageB);
    await expect(chip(bubbleWith(pageB, `${label} #1`), THUMBS_UP)).toHaveText(/1/);
    await expect(chip(bubbleWith(pageB, `${label} #1`), PRAY)).toHaveText(/1/);

    expect(errorsA, `console errors on page A: ${errorsA.join("; ")}`).toEqual([]);
    expect(errorsB, `console errors on page B: ${errorsB.join("; ")}`).toEqual([]);
    await closeAll(contextA, contextB);
  });

  test("deleting the message takes its reactions with it, for everyone", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const label = `react-delete-${Date.now()}`;

    await seed(pageA, { label, sender: "Purdy" });
    await unlockServer(pageA, "Josh");
    await unlockServer(pageB, "Purdy");
    const bubbleA = bubbleWith(pageA, `${label} #1`);
    const bubbleB = bubbleWith(pageB, `${label} #1`);
    await waitVisible(bubbleA, pageA);
    await reactFromMenu(bubbleA, "Red heart");
    await waitVisible(chip(bubbleB, HEART), pageB);

    await keepAlive(pageA);
    await pageA.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
    await bubbleA.hover();
    await bubbleA.locator(".wx-srv-message-actions-trigger").click();
    await bubbleA.getByRole("menuitem", { name: "Delete for everyone" }).click();
    await bubbleA.locator(".wx-srv-message-delete-confirm-button").click();
    await expect(bubbleA).toHaveCount(0);
    await expect(bubbleB).toHaveCount(0, { timeout: 3000 });

    await closeAll(contextA, contextB);
  });

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 360, height: 740 },
  ]) {
    test(`on a ${viewport.width}px phone: long-press opens the emoji row inside the screen, and chips wrap without overflow`, async ({ browser }) => {
      const contextA = await browser.newContext({
        viewport,
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      });
      const contextB = await browser.newContext();
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();
      const label = `react-phone-${viewport.width}-${Date.now()}`;

      // One message from each side, so the menu is anchored both ways (right edge for mine,
      // left edge for theirs).
      await seed(pageA, { label: `${label}-theirs`, sender: "Purdy" });
      await seed(pageA, { label: `${label}-mine`, sender: "Josh" });
      await unlockServer(pageA, "Josh");
      await unlockServer(pageB, "Purdy");
      const pointer = { pointerType: "touch", pointerId: 1, clientX: 40, clientY: 40, button: 0 };

      for (const side of ["theirs", "mine"] as const) {
        const bubble = bubbleWith(pageA, `${label}-${side} #1`);
        await waitVisible(bubble, pageA);
        await bubble.scrollIntoViewIfNeeded();

        await bubble.dispatchEvent("pointerdown", pointer);
        await pageA.waitForTimeout(550);
        const picker = bubble.locator(".wx-srv-message-reactions-picker");
        await expect(picker).toBeVisible();
        await bubble.dispatchEvent("pointerup", pointer);

        const box = await picker.boundingBox();
        expect(box, `the emoji row of a ${side} bubble has no box`).not.toBeNull();
        expect(box!.x, `${side} emoji row sticks out on the left`).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, `${side} emoji row sticks out on the right`).toBeLessThanOrEqual(viewport.width);
        for (const button of await picker.locator(".wx-srv-message-react").all()) {
          const buttonBox = await button.boundingBox();
          expect(buttonBox!.width).toBeGreaterThanOrEqual(36);
          expect(buttonBox!.height).toBeGreaterThanOrEqual(36);
        }

        // Pick one from the menu, then add a second — the chips wrap inside the bubble.
        await bubble.getByRole("menuitemcheckbox", { name: "Thumbs up" }).click();
        await expect(chip(bubble, THUMBS_UP)).toBeVisible({ timeout: 3000 });
        await pageA.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
        await bubble.dispatchEvent("pointerdown", pointer);
        await pageA.waitForTimeout(550);
        await bubble.dispatchEvent("pointerup", pointer);
        await bubble.getByRole("menuitemcheckbox", { name: "Crying" }).click();
        await expect(bubble.locator(".wx-srv-reaction-chip")).toHaveCount(2, { timeout: 3000 });
        await pageA.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);

        const row = await bubble.locator(".wx-srv-reactions").boundingBox();
        const bubbleBox = await bubble.boundingBox();
        expect(row!.x + row!.width).toBeLessThanOrEqual(bubbleBox!.x + bubbleBox!.width + 1);
        const chipBox = await chip(bubble, THUMBS_UP).boundingBox();
        expect(chipBox!.height).toBeGreaterThanOrEqual(28);
        // The whole chat is still unlocked: the emoji flow never tripped the double-tap lock.
        await expect(pageA.locator(".wx-srv-thread")).toBeVisible();
      }

      const overflow = await pageA.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, "the page scrolls sideways").toBeLessThanOrEqual(0);

      await closeAll(contextA, contextB);
    });
  }

  test("a reaction from the other person never cuts off a voice note that is playing", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const sender = `Voice${Date.now()}`;

    await unlockServer(pageA, sender);
    await unlockServer(pageB, "Purdy");
    const keepBAlive = setInterval(() => void pageB.mouse.move(40 + Math.random() * 30, 40), 2_000);
    try {
      // A records an ~8 second note (long enough that it is still playing when B reacts).
      await pageA.getByRole("button", { name: "Record a voice note" }).click();
      await expect(pageA.getByRole("button", { name: "Stop recording" })).toBeVisible();
      await pageA.waitForTimeout(8_000);
      const sent = pageA.waitForResponse(
        (response) =>
          response.url().endsWith("/api/admin/server/messages") && response.request().method() === "POST",
      );
      await pageA.getByRole("button", { name: "Stop recording" }).click();
      expect((await sent).status()).toBe(201);

      const voiceBubbleA = pageA.locator(".wx-srv-bubble-mine").filter({ has: pageA.locator(".wx-srv-voice") }).last();
      await expect(voiceBubbleA.locator(".wx-srv-voice-time")).toContainText(/\/ 0:0[6-9]/, { timeout: 60_000 });
      const voiceBubbleB = pageB
        .locator(".wx-srv-bubble-theirs")
        .filter({ hasText: sender })
        .filter({ has: pageB.locator(".wx-srv-voice") });
      await waitVisible(voiceBubbleB, pageB);

      // A plays it; tag the <audio> node and watch for anything that would end playback.
      const audio = voiceBubbleA.locator("audio");
      await pageA.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
      await voiceBubbleA.getByRole("button", { name: "Play voice note" }).click();
      await expect.poll(() => audio.evaluate((node) => (node as HTMLAudioElement).currentTime)).toBeGreaterThan(0.3);
      await audio.evaluate((node) => {
        const el = node as HTMLAudioElement;
        el.dataset["e2eTag"] = "same-node";
        el.dataset["endings"] = "0";
        for (const type of ["pause", "emptied", "ended"]) {
          el.addEventListener(type, () => {
            el.dataset["endings"] = String(Number(el.dataset["endings"] ?? "0") + 1);
          });
        }
      });
      const before = await audio.evaluate((node) => (node as HTMLAudioElement).currentTime);

      // B reacts to it (a `message_updated` frame reaches A while the note is playing).
      await reactFromMenu(voiceBubbleB, "Red heart");
      await waitVisible(chip(voiceBubbleA, HEART), pageA);

      const after = await audio.evaluate((node) => {
        const el = node as HTMLAudioElement;
        return {
          tag: el.dataset["e2eTag"],
          endings: el.dataset["endings"],
          connected: el.isConnected,
          paused: el.paused,
          currentTime: el.currentTime,
        };
      });
      expect(after.tag, "the <audio> node was replaced by the reaction").toBe("same-node");
      expect(after.connected).toBe(true);
      expect(after.endings, "the note was paused, emptied or ended by the reaction").toBe("0");
      expect(after.paused).toBe(false);
      expect(after.currentTime).toBeGreaterThanOrEqual(before);
    } finally {
      clearInterval(keepBAlive);
    }

    await closeAll(contextA, contextB);
  });
});
