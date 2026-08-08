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

const HIDDEN_PAIR = {
  before: { src: "images/hero.jpg", alt: "Before" },
  after: { src: "images/icon.jpg", alt: "After" },
  title: "Hidden Pair",
  sub: "Seed",
  cat: "lips",
  visible: false,
};

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
    // The text composer (decisions/00075): Enter is a newline — commit is Ctrl+Enter.
    const titleInput = frame.locator(".wx-composer-input");
    await titleInput.fill("New Treatment Card");
    await titleInput.press("Control+Enter");
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

test.describe("PR 1: a hidden collection item survives an inline structural edit (round-trip proof)", () => {
  test.beforeEach(async ({ request }) => {
    await request.delete("/api/admin/draft");
  });

  test("retitling a DIFFERENT item in the same list leaves the hidden item's visible: false intact", async ({
    page,
    request,
  }) => {
    // Same incident class as decisions/00095's `.cat` attr-drop: the editor
    // overlay's whole-array read-back (contentModel.ts:readListValue) runs on
    // EVERY structural/text edit to ANY item in a list, so a hidden item that
    // isn't itself touched must still survive the round-trip. The gallery
    // fixture (fixture_server.py) seeds exactly one hidden slider ("Hidden
    // Pair") — add one more, SHOWN item alongside it via a direct draft PATCH
    // (draft-only, auto-discarded by the next test's beforeEach) so there is
    // another item to edit.
    const consoleErrors = trackConsoleErrors(page);
    const { visible: _hiddenPairVisible, ...shownPairBase } = HIDDEN_PAIR;
    const shownPair = { ...shownPairBase, title: "Shown Pair" };

    const stateBefore = (await (await request.get("/api/admin/state")).json()) as {
      draft: { rev: number };
    };
    const setupPatch = await request.patch("/api/admin/draft", {
      data: {
        expectedRev: stateBefore.draft.rev,
        ops: [{ file: "gallery", path: "gallery.sliders", value: [HIDDEN_PAIR, shownPair] }],
      },
    });
    expect(setupPatch.status()).toBe(200);

    await gotoEditAndWaitReady(page, "gallery");
    const frame = page.frameLocator(".wx-preview-iframe");
    const items = frame.locator("ul.sliders > [data-wx-list-item]");
    await expect(items).toHaveCount(2);

    // Retitle the SECOND (shown) item — the hidden first item is never
    // clicked at all, only carried along by the whole-array re-emission.
    const patchRequest = page.waitForRequest(
      (req) => req.url().endsWith("/api/admin/draft") && req.method() === "PATCH",
    );
    await items.nth(1).locator('[data-wx=".title"]').click();
    const input = frame.locator(".wx-composer-input");
    await input.fill("Shown Pair Retitled");
    await input.press("Control+Enter");
    const req = await patchRequest;
    const body = req.postDataJSON() as {
      ops: Array<{ file: string; path: string; value: unknown }>;
    };
    const op = body.ops.find((o) => o.file === "gallery" && o.path === "gallery.sliders");
    expect(op?.value).toEqual([HIDDEN_PAIR, { ...shownPair, title: "Shown Pair Retitled" }]);

    // Round-trip proof: a FRESH preview render (server-persisted content, not
    // just the just-sent request body) still marks exactly the one hidden
    // item, untouched.
    await page.goto("/admin/preview/gallery.html");
    const hiddenItems = page.locator('[data-wx-list-item][data-wx-item-hidden="1"]');
    await expect(hiddenItems).toHaveCount(1);
    await expect(hiddenItems.locator('[data-wx=".title"]')).toHaveText("Hidden Pair");

    expect(consoleErrors).toEqual([]);
  });
});
