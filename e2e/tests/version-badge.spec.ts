// E2E for decisions/00108 — the status-bar version badge: a quiet `v N` pinned
// at page load, the green glow once a deploy lands past the loaded page, and
// the themed confirm that gates the reload (never automatic, never a changelog
// — this surface is the site owner's).

import { expect, test } from "@playwright/test";
import { trackConsoleErrors } from "./helpers";

test.describe("version badge (decisions/00108)", () => {
  test("pins v N, glows on deploy, and reloads only after the confirm", async ({ page }) => {
    const errors = trackConsoleErrors(page);

    // A mutable /api/version double: the "deploy" mid-test is just this object
    // changing — the badge must notice on its next revalidation.
    let versionPayload = {
      commit: { sha_full: "a".repeat(40), count: 158 },
      slot: "e2e",
      version: 1,
      edition: "fleet",
      syncBase: null,
    };
    await page.route("**/api/version", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(versionPayload) }),
    );

    await page.goto("/admin/pages");
    const badge = page.locator(".wx-version-badge");
    await expect(badge).toHaveText("v158");
    await expect(badge).not.toHaveClass(/wx-version-update-available/);

    // A deploy lands: the next revalidation (a tab refocus here) turns the
    // badge into the green glow — and does NOT touch the page itself (she may
    // be mid-edit; the old auto-reload is gone).
    versionPayload = { ...versionPayload, commit: { sha_full: "b".repeat(40), count: 159 } };
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(badge).toHaveText("v158 → v159");
    await expect(badge).toHaveClass(/wx-version-update-available/);
    expect(page.url()).toContain("/admin/pages"); // still right where she was

    // Tap → the themed confirmation, not a changelog. "Not now" dismisses and
    // the glow stays (it's still waiting for her).
    await badge.click();
    const dialog = page.locator(".wx-version-dialog");
    await expect(dialog).toContainText("A new version of Wixy is ready");
    await expect(dialog).toContainText("Would you like to load the latest version now?");
    await dialog.getByRole("button", { name: "Not now" }).click();
    await expect(page.locator(".wx-version-backdrop")).toHaveCount(0);
    await expect(badge).toHaveClass(/wx-version-update-available/);

    // Confirm → the page reloads onto the new version, which then pins quiet.
    await badge.click();
    await dialog.getByRole("button", { name: "Load latest version" }).click();
    await page.waitForLoadState("load");
    await expect(badge).toHaveText("v159");
    await expect(badge).not.toHaveClass(/wx-version-update-available/);
    expect(errors).toEqual([]);
  });
});
