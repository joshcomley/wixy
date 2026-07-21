// E2E for decisions/00087 — the admin routes on PROPER PATHS (`/admin/edit/
// index`, `/admin/settings/appearance`, …), not hash fragments. Every panel
// path serves the shell and the client router parses the path; legacy `#/…`
// links canonicalize (old bookmarks/chat links must never break); panel
// navigation pushStates so back/forward walk real history entries.

import { expect, test } from "@playwright/test";
import { gotoEditAndWaitReady, trackConsoleErrors } from "./helpers";

test.describe("proper path links (decisions/00087)", () => {
  test("a deep link loads the panel directly, with no hash in the URL", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoEditAndWaitReady(page, "index");
    await expect(page.locator(".wx-preview-iframe")).toBeVisible();
    const url = new URL(page.url());
    expect(url.pathname).toBe("/admin/edit/index");
    expect(url.hash, "no hash fragment in proper links").toBe("");
    expect(errors).toEqual([]);
  });

  test("panel navigation pushStates paths; back/forward walk real history", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto("/admin/pages");
    await page.waitForSelector(".wx-pages-table");
    expect(new URL(page.url()).pathname).toBe("/admin/pages");
    // Into the edit view via the pages table's Edit action (row order is the
    // fixture's own — capture whichever page it is)…
    await page.locator(".wx-pages-edit").first().click();
    await page.waitForSelector(".wx-preview-iframe");
    const editPath = new URL(page.url()).pathname;
    expect(editPath).toMatch(/^\/admin\/edit\/[a-z0-9-]+$/);
    // …back to pages via the browser's own history…
    await page.goBack();
    await page.waitForSelector(".wx-pages-table");
    expect(new URL(page.url()).pathname).toBe("/admin/pages");
    // …and forward again.
    await page.goForward();
    await page.waitForSelector(".wx-preview-iframe");
    expect(new URL(page.url()).pathname).toBe(editPath);
    expect(errors).toEqual([]);
  });

  test("a legacy #/ deep-link canonicalizes to its path and still routes", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const contentFetch = page.waitForResponse(
      (res) => res.url().includes("/api/admin/content/index") && res.request().method() === "GET",
    );
    await page.goto("/admin#/edit/index");
    await contentFetch;
    await expect(page.locator(".wx-preview-iframe")).toBeVisible();
    const url = new URL(page.url());
    expect(url.pathname, "legacy hash rewritten to the proper path").toBe("/admin/edit/index");
    expect(url.hash).toBe("");
    expect(errors).toEqual([]);
  });

  test("a bare /admin canonicalizes to the landing panel path", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto("/admin");
    await page.waitForSelector(".wx-pages-table");
    const url = new URL(page.url());
    expect(url.pathname).toBe("/admin/pages");
    expect(url.hash).toBe("");
    expect(errors).toEqual([]);
  });
});
