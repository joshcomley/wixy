// E2E 5 (spec/08-testing-acceptance.md §2): "Restore: two publishes → restore #1 →
// live serves #1 content, history has a restore entry, draft equals #1."
//
// Deferred through M7/M8 pending milestone 9's publisher/history/restore machinery
// (decisions/00015 decision 4, reiterated in 00019/00023), which slices 1-3 built.
// Never hardcodes a version NUMBER — the fixture already does one initial publish
// before the server starts (`fixture_server.py`'s `_publish_initial_build`), so this
// flow's own two publishes land at whatever versions actually follow that.

import { expect, test } from "@playwright/test";
import {
  editTextField,
  gotoEditAndWaitReady,
  publishAndWait,
  trackConsoleErrors,
  waitForNextDraftPatchAccepted,
} from "./helpers";

test.describe("E2E 5: restore", () => {
  test.beforeEach(async ({ request }) => {
    await request.delete("/api/admin/draft");
  });

  test("restoring an earlier version serves it live, records a restore entry, and resets the draft", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);

    await gotoEditAndWaitReady(page, "index");

    const firstPatch = waitForNextDraftPatchAccepted(page);
    await editTextField(page, "hero.title", "Version One Content");
    await firstPatch;
    const v1 = await publishAndWait(page);

    await gotoEditAndWaitReady(page, "index");
    const secondPatch = waitForNextDraftPatchAccepted(page);
    await editTextField(page, "hero.title", "Version Two Content");
    await secondPatch;
    const v2 = await publishAndWait(page);
    expect(v2).toBe(v1 + 1);

    // Sanity: the live site currently serves v2's content.
    const beforeRestore = await page.request.get("/");
    expect(await beforeRestore.text()).toContain("Version Two Content");

    await page.goto("/admin/history");
    const v1Row = page.locator(`tr[data-version="${v1}"]`);
    await expect(v1Row).toBeVisible();
    await v1Row.locator(".wx-history-restore").click();
    const confirmRow = page.locator(`tr[data-version="${v1}"] + tr.wx-history-confirm-row`);
    await confirmRow.locator("input").fill("RESTORE");
    const restoreResponse = page.waitForResponse(
      (res) => res.url().endsWith("/api/admin/restore") && res.request().method() === "POST",
    );
    await confirmRow.locator("button", { hasText: "Confirm restore" }).click();
    const response = await restoreResponse;
    expect(response.status()).toBe(200);

    // "live serves #1 content"
    const afterRestore = await page.request.get("/");
    expect(await afterRestore.text()).toContain("Version One Content");

    // "history has a restore entry" — a genuine reload (not another `goto` to
    // the same hash, which is a browser no-op — see `gotoEditAndWaitReady`'s own
    // doc for the identical gap): restore records a NEW ledger entry, but the
    // already-mounted table doesn't self-refresh.
    const publishesFetch = page.waitForResponse(
      (res) => res.url().includes("/api/admin/publishes") && res.request().method() === "GET",
    );
    await page.reload();
    await publishesFetch;
    const restoreRows = page.locator("tr.wx-history-live");
    await expect(restoreRows).toBeVisible();
    await expect(page.locator("table.wx-history-table")).toContainText(`Restore of version ${v1}`);
    await expect(page.locator("table.wx-history-table")).toContainText("restore");

    // "draft equals #1" — the editor now shows v1's content, not v2's.
    await gotoEditAndWaitReady(page, "index");
    const frame = page.frameLocator(".wx-preview-iframe");
    await expect(frame.locator('[data-wx="hero.title"]')).toHaveText("Version One Content");

    expect(consoleErrors).toEqual([]);
  });
});
