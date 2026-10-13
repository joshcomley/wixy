import { expect, test } from "../fixtures";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// decisions/00180: a phone keyboard's GIF picker inserts a LINK; the composer attaches the GIF
// itself, and the More menu's Fry item attaches the bundled Fry GIF. Both must play in the thread.

const MULTI_TAP_INTERVAL_MS = 400;
// A small animated GIF made for these tests (160x120, 4 frames). Every GIF the browser fetches here
// is answered with it, so the tests never load the real Fry GIF or a real GIF-host link.
const TEST_GIF = readFileSync(fileURLToPath(new URL("../fixtures/test-animated.gif", import.meta.url)));
const KEYBOARD_GIF_LINK = "https://static.klipy.com/test/local-test.gif";
const FRY_GIF_PATH = "**/admin/static/server-chat/fry-squint.gif";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
test.describe.configure({ timeout: 60_000 });

async function unlockServer(page: Page, name: string): Promise<void> {
  await page.goto("/admin/server");
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  const configResponse = await page.request.post("/test/server/config");
  const { pin } = (await configResponse.json()) as { pin: string };
  await page.locator(".wx-srv-panel").click();
  await expect(page.locator(".wx-srv-affordance")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
  await page.locator(".wx-srv-affordance").click();
  await expect(page.locator(".wx-srv-pinpad")).toBeVisible();
  for (const digit of pin) {
    await page.locator(`.wx-srv-pinpad-key-digit:text-is("${digit}")`).click();
  }
  await page.locator(".wx-srv-pinpad-key-submit").click();
  await expect(page.locator(".wx-srv-name-prompt")).toBeVisible();
  await page.locator(".wx-srv-name-prompt-input").fill(name);
  await page.locator(".wx-srv-name-prompt-button").click();
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

async function sendStagedGif(page: Page): Promise<void> {
  const send = page.locator(".wx-chat-send-button");
  await expect(page.locator(".wx-chat-attachment-chip-pending")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".wx-chat-attachment-chip .wx-chat-attachment-thumb")).toHaveCount(1);
  await expect(send).toBeEnabled({ timeout: 15_000 });
  await expect(page.locator(".wx-chat-composer-error")).toBeHidden();
  await send.click();
}

async function expectAnimatedGifBubble(page: Page): Promise<void> {
  const bubbleGif = page.locator(".wx-srv-photo-thumb.wx-srv-photo-animated").last();
  await expect(bubbleGif).toBeVisible({ timeout: 20_000 });
  await expect(bubbleGif.locator(".wx-srv-gif-badge")).toHaveText("GIF");
  await expect(bubbleGif.locator("img")).toHaveAttribute("src", /\/full\?/);
  // The bubble keeps the GIF's own shape (160x120) instead of a square crop, and fits a phone.
  const box = (await bubbleGif.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(240.5);
  expect(box.width / box.height).toBeGreaterThan(1.2);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
}

test.describe("server-gif.spec.ts", () => {
  test("a keyboard GIF link becomes an animated GIF attachment", async ({ page }) => {
    await page.route(KEYBOARD_GIF_LINK, (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/gif",
        headers: { "access-control-allow-origin": "*" },
        body: TEST_GIF,
      }),
    );
    await unlockServer(page, "Gif tester");

    const input = page.locator(".wx-chat-composer-input");
    await input.fill(`${KEYBOARD_GIF_LINK} `);
    await expect(input).toHaveValue("");
    await sendStagedGif(page);
    await expectAnimatedGifBubble(page);
    await expect(page.locator(".wx-srv-message-list")).not.toContainText("klipy");
  });

  test("the More menu's Fry item attaches the Fry GIF", async ({ page }) => {
    let fryRequested = false;
    await page.route(FRY_GIF_PATH, (route) => {
      fryRequested = true;
      return route.fulfill({ status: 200, contentType: "image/gif", body: TEST_GIF });
    });
    await unlockServer(page, "Fry tester");
    await page.locator(".wx-srv-more-button").click();
    await expect(page.locator(".wx-srv-more-fry")).toBeVisible();
    await page.locator(".wx-srv-more-fry").click();
    await expect(page.locator(".wx-srv-more-menu")).toBeHidden();
    await sendStagedGif(page);
    expect(fryRequested, "the Fry item fetched the bundled Fry GIF's address").toBe(true);
    await expectAnimatedGifBubble(page);
  });
});
