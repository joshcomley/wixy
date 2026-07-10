// E2E 4 (spec/08-testing-acceptance.md §2): "Collection: add + reorder a treatments
// card; delete an FAQ item → publish → output HTML reflects order/count."
//
// The mini-site fixture (a deliberately minimal, generic engine-level fixture, not a
// CA-specific one) has exactly ONE list-bound collection — `showcase.items` — not a
// separate "treatments" list and "FAQ" list. Both halves of this flow (add+reorder,
// delete) exercise `showcase.items`, matching decisions/00023 decision 3's already-
// established precedent of substituting the closest available fixture element for a
// CA-specific name rather than inventing CA-shaped fixture data this generic suite
// was never meant to carry.

import { expect, test } from "@playwright/test";
import {
  gotoEditAndWaitReady,
  publishAndWait,
  trackConsoleErrors,
  waitForNextDraftPatchAccepted,
} from "./helpers";

test.describe("E2E 4: collection", () => {
  test.beforeEach(async ({ request }) => {
    await request.delete("/api/admin/draft");
  });

  test("add, fill, reorder, and delete a showcase item, publish, and the output reflects order and count", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);

    await gotoEditAndWaitReady(page, "index");
    const frame = page.frameLocator(".wx-preview-iframe");
    // Scoped to the showcase list's DIRECT children only — the fixture's header/
    // footer partials (nav, footer legal links) and each item's own nested `.tags`
    // sub-list all carry `data-wx-list-item` too.
    const items = frame.locator("ul.showcase > [data-wx-list-item]");
    await expect(items).toHaveCount(2);

    // "add" — hover any item to reveal the toolbar (add always clones the list's
    // first item, blanked, regardless of which item is hovered).
    const addPatch = waitForNextDraftPatchAccepted(page);
    await items.first().hover();
    await frame.locator('.wx-item-toolbar button[data-wx-toolbar-action="add"]').click();
    await addPatch;
    await expect(items).toHaveCount(3);

    // Give the new (blank) third item distinct, identifiable content.
    const newItem = items.nth(2);
    const titlePatch = waitForNextDraftPatchAccepted(page);
    await newItem.locator('[data-wx=".title"]').click();
    const titleInput = frame.locator(".wx-popover input, .wx-popover textarea").first();
    await titleInput.fill("New Treatment Card");
    await titleInput.press("Enter");
    await titlePatch;
    await expect(newItem.locator('[data-wx=".title"]')).toHaveText("New Treatment Card");

    // "reorder" — move the new item up one slot: [Item One, New, Item Two] -> was
    // [Item One, Item Two, New].
    const reorderPatch = waitForNextDraftPatchAccepted(page);
    await newItem.hover();
    await frame.locator('.wx-item-toolbar button[data-wx-toolbar-action="moveUp"]').click();
    await reorderPatch;
    await expect(items.nth(1).locator('[data-wx=".title"]')).toHaveText("New Treatment Card");

    // "delete an FAQ item" (substituted: delete the original "Item Two", now last).
    const deletePatch = waitForNextDraftPatchAccepted(page);
    await items.nth(2).hover();
    await frame.locator('.wx-item-toolbar button[data-wx-toolbar-action="delete"]').click();
    await deletePatch;
    await expect(items).toHaveCount(2);

    await publishAndWait(page);

    // "output HTML reflects order/count"
    const liveResponse = await page.request.get("/");
    expect(liveResponse.status()).toBe(200);
    const liveHtml = await liveResponse.text();
    expect(liveHtml).toContain("Item One");
    expect(liveHtml).toContain("New Treatment Card");
    expect(liveHtml).not.toContain("Item Two");
    expect(liveHtml.indexOf("Item One")).toBeLessThan(liveHtml.indexOf("New Treatment Card"));

    // Count via a real DOM query (direct children only, so the nested `.tags` list's
    // own `<li>`s per item don't inflate the count) rather than a fragile HTML regex.
    await page.goto("/");
    await expect(page.locator("ul.showcase > li")).toHaveCount(2);

    expect(consoleErrors).toEqual([]);
  });
});
