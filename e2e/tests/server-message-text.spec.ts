// Line breaks in a Server chat message (operator report, round 2, 2026-09-25): a message
// typed on several lines showed as one run-on paragraph, because `.wx-srv-bubble-text`
// used the default `white-space: normal`, which collapses every newline to a space.
// Real layout only — jsdom never lays anything out, and `innerText` (unlike
// `textContent`) reflects the rendered line breaks, so it is the observable the
// operator actually saw.

import { expect, test, type Locator, type Page } from "@playwright/test";

const VIEWPORTS = [
  { label: "desktop", width: 1280, height: 900 },
  { label: "phone", width: 402, height: 870 },
] as const;

/** Mirrors `MULTI_TAP_INTERVAL_MS` in admin-ui/src/server/constants.ts. */
const MULTI_TAP_INTERVAL_MS = 400;

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

/** The server-confirmed bubble (not the optimistic `.wx-srv-echo`) whose text contains
 * `marker` - selected by its own unique text, never `.last()`, so a read can never land on
 * a neighbouring message. */
function confirmedBubbleText(page: Page, marker: string): Locator {
  return page.locator(".wx-srv-bubble-mine:not(.wx-srv-echo) .wx-srv-bubble-text", { hasText: marker });
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator(".wx-srv-thread-view textarea").fill(text);
  await page.locator(".wx-srv-thread-view .wx-chat-send-button").click();
}

/** `innerText` reflects the rendered line breaks; poll so the read follows the echo ->
 * confirmed swap instead of racing it. */
async function renderedText(bubbleText: Locator): Promise<string> {
  await expect(bubbleText).toHaveCount(1);
  return bubbleText.evaluate((el) => (el as HTMLElement).innerText);
}

for (const viewport of VIEWPORTS) {
  test.describe(`line breaks in a message bubble (${viewport.label})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("a message typed on two lines renders on two lines", async ({ page }) => {
      await unlockServer(page, "Newline");
      const stamp = `nl-${viewport.label}-${Date.now()}`;
      const text = `first ${stamp}
second ${stamp}`;
      await send(page, text);
      const bubble = confirmedBubbleText(page, `first ${stamp}`);
      await expect.poll(() => renderedText(bubble)).toBe(text);
    });

    test("a blank line between paragraphs is kept, and a link on the second line still links", async ({ page }) => {
      await unlockServer(page, "Newline");
      const stamp = `nl2-${viewport.label}-${Date.now()}`;
      const text = `para one ${stamp}

para two https://example.com/${stamp}`;
      await send(page, text);
      const bubble = confirmedBubbleText(page, `para one ${stamp}`);
      await expect.poll(() => renderedText(bubble)).toBe(text);
      await expect(bubble.locator(`a[href="https://example.com/${stamp}"]`)).toHaveCount(1);
    });

    test("the two lines really are stacked, not laid out side by side", async ({ page }) => {
      await unlockServer(page, "Newline");
      // Short on purpose: on a 402px phone a long two-part message wraps to two lines even
      // without honouring the newline, which would let this pass on the unfixed code.
      const n = String(Date.now() % 100000);
      await send(page, `up ${n}
down ${n}`);
      const bubble = confirmedBubbleText(page, `up ${n}`);
      await expect(bubble).toHaveCount(1);
      await expect
        .poll(async () =>
          bubble.evaluate((el) => {
            const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
            return el.getBoundingClientRect().height / lineHeight;
          }),
        )
        .toBeGreaterThanOrEqual(1.9);
    });
  });
}
