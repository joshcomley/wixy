// E2E: media editing (decisions/00079) — the media panel's detail sheet
// stages an in-place replacement (grid previews staged bytes immediately)
// and publishes it (the repo file is overwritten, references untouched).
import { expect, test } from "@playwright/test";
import { publishAndWait, trackConsoleErrors } from "./helpers";

test.describe("media editing", () => {
  test.beforeEach(async ({ request }) => {
    await request.delete("/api/admin/draft");
  });

  test("replacing an image stages it, previews it, and publishes it in place", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);

    await page.goto("/admin#/media");
    await expect(page.locator(".wx-media-grid")).toBeVisible();

    // open the detail sheet for hero.jpg (by its img alt — the grid is
    // alphabetical and earlier specs publish files that sort before it)
    await page.locator('.wx-media-thumb:has(img[alt="hero.jpg"])').click();
    const sheet = page.locator(".wx-media-detail");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("hero.jpg");

    // replace with a real jpeg file (the e2e fixture image)
    await sheet.locator('input[type="file"]').setInputFiles("fixtures/oversized-exif-rotated.jpg");

    // staged: badge on the grid + staged bytes served from the staging URL
    await expect(page.locator(".wx-media-badge-staged").first()).toHaveText("replace staged");
    const stagedResponse = await page.request.get("/admin/draft-media-replace/hero.jpg");
    expect(stagedResponse.status()).toBe(200);

    // publish applies it in place — the repo file now serves the new bytes
    await publishAndWait(page);
    const liveResponse = await page.request.get("/images/hero.jpg");
    expect(liveResponse.status()).toBe(200);
    expect(liveResponse.headers()["content-type"]).toContain("image");
    const stagedLength = (await stagedResponse.body()).length;
    const liveLength = (await liveResponse.body()).length;
    expect(liveLength).toBe(stagedLength);

    // staging cleared
    const stagedAgain = await page.request.get("/admin/draft-media-replace/hero.jpg");
    expect(stagedAgain.status()).toBe(404);

    expect(consoleErrors).toEqual([]);
  });
});
