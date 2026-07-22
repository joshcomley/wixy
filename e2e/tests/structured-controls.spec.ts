// E2E: structured controls (decisions/00077) — the data-wx-control attribute
// routes a text binding to a dedicated sheet instead of the composer: the
// opening-hours control edits the whole @hours array as day/time rows; the
// price control edits a price text as label/amount rows; the qa control edits
// the whole Q&A array as question/answer cards in a FULL-SCREEN surface
// (decisions/00090). All three publish live.
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

  test("the qa control edits the whole list in a full-screen surface and publishes", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);
    await gotoEditAndWaitReady(page, "index");
    const frame = page.frameLocator(".wx-preview-iframe");

    // click a question (the summary carries the control attr)
    await frame.locator('[data-wx=".question"][data-wx-control="qa"]').first().click();
    const sheet = frame.locator(".wx-control-fullscreen");
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".wx-qa-row")).toHaveCount(2);

    // full-screen: the sheet covers the preview iframe's viewport (a bottom
    // sheet would be a fraction of its height). Scrollbars can shave a few
    // percent off the width, so assert coverage, not equality.
    const iframeBox = await page.locator(".wx-preview-iframe").boundingBox();
    const sheetBox = await sheet.boundingBox();
    expect(iframeBox).not.toBeNull();
    expect(sheetBox).not.toBeNull();
    expect(sheetBox?.x).toBeCloseTo(iframeBox?.x ?? 0, 0);
    expect(sheetBox?.y).toBeCloseTo(iframeBox?.y ?? 0, 0);
    expect((sheetBox?.width ?? 0) / (iframeBox?.width ?? 1)).toBeGreaterThan(0.9);
    expect((sheetBox?.height ?? 0) / (iframeBox?.height ?? 1)).toBeGreaterThan(0.9);

    // edit the first question and add a new pair
    await sheet
      .locator(".wx-qa-question")
      .first()
      .fill("Do I need a consultation first, and is it free?");
    await sheet.locator(".wx-qa-add").click();
    const rows = sheet.locator(".wx-qa-row");
    await expect(rows).toHaveCount(3);
    await rows.nth(2).locator(".wx-qa-question").fill("Where are you?");
    await rows.nth(2).locator(".wx-qa-answer").fill("Hartlebury, with free parking outside.");

    const patchPromise = page.waitForResponse(
      (res) => res.url().endsWith("/api/admin/draft") && res.request().method() === "PATCH",
    );
    await sheet.locator(".wx-control-commit").click();
    await patchPromise;

    // the preview reflected the change immediately (third item rendered)
    const items = frame.locator('[data-wx-list="faq.items"] > [data-wx-list-item]');
    await expect(items).toHaveCount(3);
    await expect(items.nth(2).locator('[data-wx=".question"]')).toHaveText("Where are you?");

    await publishAndWait(page);
    const live = await (await page.request.get("/")).text();
    expect(live).toContain("Do I need a consultation first, and is it free?");
    expect(live).toContain("Hartlebury, with free parking outside.");
    expect(consoleErrors).toEqual([]);
  });
});
