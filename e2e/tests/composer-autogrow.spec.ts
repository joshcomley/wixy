// Composer auto-grow regression (decisions/00079): the bottom composer's textarea
// must size itself to its SEEDED content the moment it opens — the initial fit
// once ran while the element was still detached from the document, where
// scrollHeight is always 0, so every composer opened as a ~16px sliver (height
// 0px + padding) that only grew after the first keystroke. jsdom can never catch
// that (its scrollHeight is always 0 too) — this needs a real browser.

import { expect, test } from "@playwright/test";
import {
  gotoEditAndWaitReady,
  trackConsoleErrors,
  waitForNextDraftPatchAccepted,
} from "./helpers";

const LONG = (
  "Tucked away in the Kentish countryside, our cottage is a peaceful " +
  "countryside retreat where you never feel rushed. "
)
  .repeat(6)
  .trim();

test.describe("composer auto-grow", () => {
  test.beforeEach(async ({ request }) => {
    await request.delete("/api/admin/draft");
  });

  test("textarea fits its seeded content on open, capped at the max height", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);
    await gotoEditAndWaitReady(page, "index");
    const frame = page.frameLocator(".wx-preview-iframe");

    // Short seed: one full row, fully visible — never a clipped sliver.
    await frame.locator('[data-wx="hero.title"]').click();
    const box = frame.locator(".wx-composer-input");
    await expect(box).toBeVisible();
    const short = await box.evaluate((el) => ({
      client: el.clientHeight,
      scroll: el.scrollHeight,
    }));
    // One rendered row is ~40px (15px/1.45 text + 2×8px padding); the bug gave 16.
    expect(short.client).toBeGreaterThanOrEqual(36);
    expect(short.scroll).toBeLessThanOrEqual(short.client + 1); // nothing clipped

    // Commit a long, wrapping value, then reopen: the reopened composer must
    // open ALREADY grown (this was the reported bug — it opened at height 0px).
    const patchAccepted = waitForNextDraftPatchAccepted(page);
    await box.fill(LONG);
    await box.press("Control+Enter");
    await patchAccepted;

    await frame.locator('[data-wx="hero.title"]').click();
    const grownBox = frame.locator(".wx-composer-input");
    await expect(grownBox).toBeVisible();
    const grown = await grownBox.evaluate((el) => ({
      client: el.clientHeight,
      scroll: el.scrollHeight,
      overflow: getComputedStyle(el).overflowY,
    }));
    expect(grown.client).toBeGreaterThan(72); // clearly multi-row: it GREW on open
    expect(grown.client).toBeLessThanOrEqual(100); // ...up to the ~5-line cap
    if (grown.scroll > grown.client) {
      expect(grown.overflow).toBe("auto"); // capped: scrolls, never clips
    }

    expect(consoleErrors).toEqual([]);
  });
});
