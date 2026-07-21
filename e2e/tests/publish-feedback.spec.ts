// E2E for decisions/00089 — publish progress feedback is shell-owned. The
// operator's ask (2026-07-21): "The publish button should get a spinner icon at
// least, and some notification when it's live." Pins: the status-bar Publish
// button spins SYNCHRONOUSLY with the confirm click (the in-flight bridge, not
// a poll's discovery), exactly one "is live" toast arrives on completion — and
// still arrives when the drawer is closed mid-publish (the shell's watch, not
// the drawer, owns completion).

import { expect, test, type Page } from "@playwright/test";
import { editTextField, gotoEditAndWaitReady, trackConsoleErrors, waitForNextDraftPatchAccepted } from "./helpers";

/** Stages one text edit and lets the shell's post-accept background state
 * refresh settle, so the publish drawer's expectedRev is current (the same
 * race publishAndWait retries around — one edit + this buffer converges). */
async function stageEdit(page: Page, value: string): Promise<void> {
  await gotoEditAndWaitReady(page, "index");
  const patched = waitForNextDraftPatchAccepted(page);
  await editTextField(page, "hero.title", value);
  await patched;
  await page.waitForTimeout(600);
}

test.describe("publish progress feedback (decisions/00089)", () => {
  test("the status-bar button spins from the confirm click, and exactly one toast announces live", async ({
    page,
  }) => {
    const errors = trackConsoleErrors(page);
    await stageEdit(page, "Feedback spins once");

    await page.click(".wx-statusbar .wx-publish-button");
    await page.waitForSelector(".wx-publish-confirm");
    const publishResponse = page.waitForResponse(
      (res) => res.url().endsWith("/api/admin/publish") && res.request().method() === "POST",
    );
    await page.click(".wx-publish-confirm");

    // Synchronous with the click — not something a state poll discovers later.
    await expect(page.locator(".wx-statusbar .wx-publish-button .wx-spinner")).toBeVisible();
    await expect(page.locator(".wx-statusbar .wx-publish-button")).toContainText("Publishing…");
    await expect(page.locator(".wx-statusbar .wx-draft-chip")).toHaveText("Publishing…");

    const response = await publishResponse;
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { version: number };

    // The announcement (watch poll cadence is 2s; the toast lives 6s).
    const liveToast = page.locator(".wx-toast").filter({ hasText: `Published — version ${body.version} is live.` });
    await expect(liveToast).toBeVisible({ timeout: 10_000 });
    // …and exactly once — the drawer's success path and the watch are
    // version-guarded against double-announce. Wait past another poll cycle.
    await page.waitForTimeout(2600);
    await expect(page.locator(".wx-toast").filter({ hasText: "is live." })).toHaveCount(1);

    // The drawer's confirm is REALLY gone (wx-button-busy's inline-flex once
    // kept it visible next to "Published as version N." — the hidden attribute
    // loses to a display rule without the [hidden] guard).
    await expect(page.locator(".wx-publish-confirm")).toBeHidden();
    await expect(page.locator(".wx-publish-progress")).toHaveText(`Published as version ${body.version}.`);

    // The bar is restored once the toast's job is terminal.
    await expect(page.locator(".wx-statusbar .wx-publish-button .wx-spinner")).toHaveCount(0);
    await expect(page.locator(".wx-statusbar .wx-publish-button")).toHaveText("Publish");
    expect(errors).toEqual([]);
  });

  test("closing the drawer mid-publish still announces live", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await stageEdit(page, "Feedback survives drawer close");

    await page.click(".wx-statusbar .wx-publish-button");
    await page.waitForSelector(".wx-publish-confirm");
    const publishResponse = page.waitForResponse(
      (res) => res.url().endsWith("/api/admin/publish") && res.request().method() === "POST",
    );
    await page.click(".wx-publish-confirm");
    // The drawer's whole lifecycle is now irrelevant to the feedback.
    await page.click(".wx-drawer-close");
    await expect(page.locator(".wx-drawer-wide")).toHaveCount(0);

    const response = await publishResponse;
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { version: number };

    const liveToast = page.locator(".wx-toast").filter({ hasText: `Published — version ${body.version} is live.` });
    await expect(liveToast).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".wx-statusbar .wx-publish-button .wx-spinner")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
