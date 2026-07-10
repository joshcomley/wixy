// E2E 1 (spec/08-testing-acceptance.md §2): "Text edit: open /admin → Edit home →
// click hero title → type → live DOM updates → draft chip shows 1 change → Publish
// → live page (public route) shows the new text → History gained a version."
//
// The first E2E flow to exercise a REAL publish (milestone 9's publisher) — deferred
// through M7/M8 pending exactly this (decisions/00015 decision 4, reiterated in
// 00019/00023). Needs `e2e/fixture_server.py`'s bare-origin fix (decisions/00030) —
// the fixture's site-origin was a non-bare working-tree repo that would have refused
// the pipeline's `git push` the moment any flow tried to actually publish.

import { expect, test } from "@playwright/test";
import {
  editTextField,
  gotoEditAndWaitReady,
  publishAndWait,
  trackConsoleErrors,
  waitForNextDraftPatchAccepted,
} from "./helpers";

test.describe("E2E 1: text edit", () => {
  test.beforeEach(async ({ request }) => {
    await request.delete("/api/admin/draft");
  });

  test("editing the hero title publishes and appears live, with a new history entry", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);

    await gotoEditAndWaitReady(page, "index");
    const frame = page.frameLocator(".wx-preview-iframe");

    const newTitle = "Published via E2E 1";
    const patchAccepted = waitForNextDraftPatchAccepted(page);
    await editTextField(page, "hero.title", newTitle);
    await patchAccepted;

    // "live DOM updates"
    await expect(frame.locator('[data-wx="hero.title"]')).toHaveText(newTitle);

    // "draft chip shows 1 change"
    await expect(page.locator(".wx-draft-chip")).toHaveText("1 change");

    const version = await publishAndWait(page);

    // "live page (public route) shows the new text"
    const liveResponse = await page.request.get("/");
    expect(liveResponse.status()).toBe(200);
    expect(await liveResponse.text()).toContain(newTitle);

    // "History gained a version"
    await page.goto("/admin#/history");
    await expect(page.locator(`tr[data-version="${version}"]`)).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });
});
