// E2E: structured controls (decisions/00077) — the data-wx-control attribute
// routes a text binding to a dedicated sheet instead of the composer: the
// opening-hours control edits the whole @hours array as day/time rows; the
// price control edits a price text as label/amount rows. Both publish live.
import { expect, test } from "@playwright/test";
import { gotoEditAndWaitReady, publishAndWait, trackConsoleErrors } from "./helpers";

test.describe("structured controls", () => {
  test.beforeEach(async ({ request }) => {
    await request.delete("/api/admin/draft");
  });

  test("the opening-hours control edits the whole array as rows and publishes", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);
    await gotoEditAndWaitReady(page, "index");
    const frame = page.frameLocator(".wx-preview-iframe");

    // click a visible hours value (the open-variant span carries the control attr)
    await frame.locator('[data-wx-if="!.closed"][data-wx-control="opening-hours"]').first().click();
    const sheet = frame.locator(".wx-control-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".wx-control-row")).toHaveCount(3);

    // flip Monday to closed and change Tuesday's opening time
    const rows = sheet.locator(".wx-control-row");
    await rows.nth(0).locator(".wx-control-closed").check();
    const tuesdayFrom = rows.nth(1).locator(".wx-control-time").first();
    await tuesdayFrom.fill("09:30");

    const patchPromise = page.waitForResponse(
      (res) => res.url().endsWith("/api/admin/draft") && res.request().method() === "PATCH",
    );
    await sheet.locator(".wx-control-commit").click();
    await patchPromise;

    // the preview reflected the change immediately (Monday's closed span visible)
    const mondayItem = frame.locator('[data-wx-list="@hours"] > [data-wx-list-item]').first();
    await expect(mondayItem.locator('[data-wx-if=".closed"]')).toBeVisible();

    await publishAndWait(page);
    const live = await (await page.request.get("/")).text();
    expect(live).toContain("09:30 – 19:00");
    expect(consoleErrors).toEqual([]);
  });

  test("the price control edits label/amount rows and publishes", async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    await gotoEditAndWaitReady(page, "index");
    const frame = page.frameLocator(".wx-preview-iframe");

    await frame.locator('[data-wx="cta.priceNote"]').click();
    const sheet = frame.locator(".wx-control-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".wx-price-rows .wx-control-row")).toHaveCount(2);

    // change the first entry's amount
    await sheet.locator(".wx-price-amount").first().fill("£55");

    const patchPromise = page.waitForResponse(
      (res) => res.url().endsWith("/api/admin/draft") && res.request().method() === "PATCH",
    );
    await sheet.locator(".wx-control-commit").click();
    await patchPromise;

    await expect(frame.locator('[data-wx="cta.priceNote"]')).toContainText("£55");

    await publishAndWait(page);
    const live = await (await page.request.get("/")).text();
    expect(live).toContain("Full consult — £55");
    expect(consoleErrors).toEqual([]);
  });
});
