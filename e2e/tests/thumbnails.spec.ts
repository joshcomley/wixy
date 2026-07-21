// E2E: page thumbnails (decisions/00078) — the Pages panel backfills missing
// thumbnails client-side (404 → placeholder → capture → PUT → real img).
import { expect, test } from "@playwright/test";
import { trackConsoleErrors } from "./helpers";

test.describe("page thumbnails", () => {
  test("the pages panel backfills and displays a mobile thumbnail", async ({ page, request }) => {
    const consoleErrors = trackConsoleErrors(page);

    await page.goto("/admin/pages");
    await expect(page.locator(".wx-pages-table")).toBeVisible();

    // Either a placeholder (never captured) or a real img (captured in a
    // previous run) is present immediately; if missing, the panel backfills.
    const thumbImg = page.locator('tr[data-slug="index"] .wx-pages-thumb-img');

    // the server eventually holds a capture (client backfill PUTs it)
    await expect
      .poll(async () => (await request.get("/api/admin/pages/index/thumbnail")).status(), {
        timeout: 20_000,
      })
      .toBe(200);

    // and the panel's img loads successfully (real pixels, not the placeholder)
    await expect
      .poll(
        async () =>
          thumbImg.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
        { timeout: 20_000 },
      )
      .toBe(true);

    expect(consoleErrors).toEqual([]);
  });
});
