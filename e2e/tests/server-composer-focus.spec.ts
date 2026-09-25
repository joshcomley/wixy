// Focus after Send in the Server chat (operator report, round 2, 2026-09-25): after sending a
// message the input box lost focus, so the next message needed a tap or click back into it.
// Cause: `send()` calls `composer.setBusy(true)`, which sets `textarea.disabled = true`, and
// disabling a focused element drops its focus; nothing restored it after `setBusy(false)`.
// Real focus only - jsdom does not blur an element when it is disabled, so a unit test cannot
// reproduce the bug; `toBeFocused()` reads the real `document.activeElement`.

import { expect, test, type Page } from "@playwright/test";

const VIEWPORTS = [
  { label: "desktop", width: 1280, height: 900 },
  { label: "phone", width: 402, height: 870 },
] as const;

/** Mirrors `MULTI_TAP_INTERVAL_MS` in admin-ui/src/server/constants.ts. */
const MULTI_TAP_INTERVAL_MS = 400;

const COMPOSER_TEXTAREA = ".wx-srv-thread-view textarea";
const SEND_BUTTON = ".wx-srv-thread-view .wx-chat-send-button";

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

/** The server-confirmed bubble (not the optimistic `.wx-srv-echo`) containing `marker`. */
function confirmedBubble(page: Page, marker: string) {
  return page.locator(".wx-srv-bubble-mine:not(.wx-srv-echo) .wx-srv-bubble-text", { hasText: marker });
}

for (const viewport of VIEWPORTS) {
  test.describe(`composer focus after Send (${viewport.label})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("pressing Enter keeps the caret in the input", async ({ page }) => {
      await unlockServer(page, "Focus");
      const marker = `enter-${viewport.label}-${Date.now()}`;
      const input = page.locator(COMPOSER_TEXTAREA);
      await input.click();
      await input.fill(marker);
      await input.press("Enter");
      await expect(confirmedBubble(page, marker)).toHaveCount(1);
      await expect(input).toHaveValue("");
      await expect(input).toBeFocused();
    });

    test("clicking Send keeps the caret in the input", async ({ page }) => {
      await unlockServer(page, "Focus");
      const marker = `click-${viewport.label}-${Date.now()}`;
      const input = page.locator(COMPOSER_TEXTAREA);
      await input.click();
      await input.fill(marker);
      await page.locator(SEND_BUTTON).click();
      await expect(confirmedBubble(page, marker)).toHaveCount(1);
      await expect(input).toHaveValue("");
      await expect(input).toBeFocused();
    });

    test("a failed send keeps the typed text and the caret in the input", async ({ page }) => {
      await unlockServer(page, "Focus");
      // Fail only the POST that sends a message; history/stream GETs on the same path go through.
      await page.route("**/api/admin/server/messages", (route) => {
        if (route.request().method() === "POST") {
          return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
        }
        return route.continue();
      });
      const marker = `fail-${viewport.label}-${Date.now()}`;
      const input = page.locator(COMPOSER_TEXTAREA);
      await input.click();
      await input.fill(marker);
      await input.press("Enter");
      await expect(page.locator(".wx-srv-thread-view .wx-chat-composer-error")).toBeVisible();
      await expect(input).toHaveValue(marker);
      await expect(input).toBeFocused();
    });

    test("focus the user moved elsewhere during the send is not stolen back", async ({ page }) => {
      await unlockServer(page, "Focus");
      // Hold the send response open so there is time to move focus while it is in flight.
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/api/admin/server/messages", async (route) => {
        if (route.request().method() === "POST") {
          await held;
        }
        await route.continue();
      });
      const marker = `steal-${viewport.label}-${Date.now()}`;
      const input = page.locator(COMPOSER_TEXTAREA);
      await input.click();
      await input.fill(marker);
      await input.press("Enter");
      // The send never disables the input (that was the flicker bug); the optimistic echo
      // bubble is what proves the send is genuinely still in flight.
      await expect(page.locator(".wx-srv-bubble-mine.wx-srv-echo", { hasText: marker })).toHaveCount(1);
      await expect(input).toHaveValue("");
      // The user moves to the settings gear while the message is still sending.
      const gear = page.locator(".wx-srv-settings-button");
      await gear.focus();
      await expect(gear).toBeFocused();
      release();
      await expect(confirmedBubble(page, marker)).toHaveCount(1);
      await expect(gear).toBeFocused();
    });
  });
}
