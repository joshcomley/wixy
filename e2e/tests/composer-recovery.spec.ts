// E2E for decisions/00088 — composer draft recovery. The operator's scenario
// (2026-07-21): "if ever something's being edited, but then the page reloads
// for whatever reason mid-edit some text, it should remember the text… hey,
// you were editing this before, would you like to restore?" The composer
// persists every keystroke to localStorage keyed by the binding; a reload is
// then lossless, and reopening the same binding offers Restore / Discard.
// Both flows are side-effect-free (cancel/discard leave no draft and no op).

import { expect, test, type Page } from "@playwright/test";
import { gotoEditAndWaitReady, trackConsoleErrors } from "./helpers";

const FRAME = ".wx-preview-iframe";

async function reloadEditView(page: Page, slug: string): Promise<void> {
  const contentFetch = page.waitForResponse(
    (res) => res.url().includes(`/api/admin/content/${slug}`) && res.request().method() === "GET",
  );
  await page.reload();
  await contentFetch;
  await page.waitForTimeout(400); // overlay init after the content hop (helper's buffer)
}

test.describe("composer draft recovery (decisions/00088)", () => {
  test("text typed mid-edit survives a reload and Restore refills the composer", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoEditAndWaitReady(page, "index");
    const frame = page.frameLocator(FRAME);
    await frame.locator('[data-wx="hero.title"]').first().click();
    await frame.locator(".wx-composer-input").fill("Recovered after reload");

    await reloadEditView(page, "index");

    await frame.locator('[data-wx="hero.title"]').first().click();
    const banner = frame.locator(".wx-composer-draft-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("You were editing this before");
    await frame.locator(".wx-composer-draft-restore").click();
    await expect(frame.locator(".wx-composer-input")).toHaveValue("Recovered after reload");
    await expect(banner).not.toBeVisible();

    // Cancel is side-effect-free: clears the draft, restores the original DOM.
    await frame.locator(".wx-composer-cancel").click();
    await reloadEditView(page, "index");
    await frame.locator('[data-wx="hero.title"]').first().click();
    await expect(frame.locator(".wx-composer-draft-banner")).toHaveCount(0);
    await frame.locator(".wx-composer-cancel").click();
    expect(errors).toEqual([]);
  });

  test("Discard drops the stored draft and keeps the fresh seed", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoEditAndWaitReady(page, "index");
    const frame = page.frameLocator(FRAME);
    await frame.locator('[data-wx="hero.title"]').first().click();
    const seed = await frame.locator(".wx-composer-input").inputValue();
    await frame.locator(".wx-composer-input").fill("Different text entirely");

    await reloadEditView(page, "index");

    await frame.locator('[data-wx="hero.title"]').first().click();
    await frame.locator(".wx-composer-draft-discard").click();
    await expect(frame.locator(".wx-composer-input")).toHaveValue(seed);

    // …and the discard sticks: a further reload offers nothing.
    await frame.locator(".wx-composer-cancel").click();
    await reloadEditView(page, "index");
    await frame.locator('[data-wx="hero.title"]').first().click();
    await expect(frame.locator(".wx-composer-draft-banner")).toHaveCount(0);
    await frame.locator(".wx-composer-cancel").click();
    expect(errors).toEqual([]);
  });
});
