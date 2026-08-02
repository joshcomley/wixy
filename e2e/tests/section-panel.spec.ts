// E2E (decisions/00098): the registry-configured admin section editor — the
// Before & After photo-pair editor `ca.json` declares for its `gallery` page.
// The E2E fixture (`fixture_server.py:_write_gallery_page`) adds a REAL
// `gallery` page + `content/gallery.json` using the SAME `gallery.sliders`/
// `gallery.tiles` collection paths and schemas `builder.collections.
// COLLECTION_RULES` registers in production (from PR 1) — so the write gate,
// publish pipeline, and rendering are all exercised for real here, not faked.
//
// Full owner journey: add a photo pair (uploading two images through the
// guided dialog), add a second pair (picking already-uploaded media), retitle,
// reorder via the ↑/↓ buttons, publish, and assert the built output. Plus the
// publish-blocked write-gate journey (brief explicitly allows skipping the
// drawer-blocked -> Fix-it-for-me -> publishable UI combo here — PR 1's own
// suite already covers that; this just confirms the SAME 1c gate rejects a
// structurally-invalid write through this new panel's content path too).

import { expect, test, type Page } from "@playwright/test";
import { publishAndWait, trackConsoleErrors, waitForNextDraftPatchAccepted } from "./helpers";

async function gotoSectionAndWaitReady(page: Page, sectionId: string, pageSlug: string): Promise<void> {
  const contentFetch = page.waitForResponse(
    (res) => res.url().includes(`/api/admin/content/${pageSlug}`) && res.request().method() === "GET",
  );
  const target = `/admin/section/${sectionId}`;
  if (page.url().endsWith(target)) {
    await page.reload();
  } else {
    await page.goto(target);
  }
  await contentFetch;
}

test.describe("E2E: registry-configured section editor (Before & After)", () => {
  test.beforeEach(async ({ request }) => {
    await request.delete("/api/admin/draft");
  });

  test("add a photo pair (uploading two images), add a second (picking existing media), retitle, reorder via buttons, publish, and the output reflects it", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);

    await gotoSectionAndWaitReady(page, "before-after", "gallery");

    const slidersCollection = page.locator(".wx-section-collection", { hasText: "Drag-to-compare photos" });
    await expect(slidersCollection.locator(".wx-section-empty")).toHaveText(
      "No photo pairs yet — add your first photo pair.",
    );

    const addDialog = page.locator(".wx-section-add-dialog");
    const mediaDialog = page.locator(".wx-media-dialog-backdrop");

    // -- Pair #1: upload two images through the guided dialog ----------------
    await slidersCollection.locator(".wx-section-add-button").click();
    await expect(addDialog).toBeVisible();

    // Never assume an exact starting count: the e2e suite reuses ONE
    // server/storage per Playwright worker across every spec file in it
    // (decisions/00097's addendum first documented this), and an earlier
    // spec's own upload/replace can leave residual `draft_media/` files this
    // dialog's grid also lists, on top of the fixture's 2 repo images
    // (hero.jpg, icon.jpg). `waitForStableThumbCount` first waits for the
    // grid to be non-empty (`toHaveCount` auto-retries — proves the dialog's
    // own async `getMedia()` fetch has resolved at least once, unlike a bare
    // `.count()` snapshot, which doesn't wait and can race that fetch), THEN
    // takes a `.count()` reading — safe at that point, since the fetch
    // already settled and the grid renders in one paint, not incrementally.
    const mediaThumbs = mediaDialog.locator(".wx-media-thumb");
    async function waitForStableThumbCount(): Promise<number> {
      await expect(mediaThumbs.first()).toBeVisible();
      return mediaThumbs.count();
    }

    await addDialog.getByRole("button", { name: "Choose Before photo" }).click();
    await expect(mediaDialog).toBeVisible();
    let thumbCountBefore = await waitForStableThumbCount();
    await mediaDialog.locator('input[type="file"]').setInputFiles("fixtures/oversized-exif-rotated.jpg");
    await expect(mediaThumbs).toHaveCount(thumbCountBefore + 1);
    await mediaThumbs.last().click();
    await mediaDialog.getByRole("button", { name: "Use this image" }).click();
    await expect(mediaDialog).toBeHidden();
    await addDialog.getByRole("button", { name: "Next" }).click();

    await addDialog.getByRole("button", { name: "Choose After photo" }).click();
    await expect(mediaDialog).toBeVisible();
    // A second, genuinely DISTINCT upload — `process_upload` (wixy_server/
    // media.py) hashes the FINAL RE-ENCODED bytes to name the staged file,
    // deliberately so re-uploading the exact same image dedupes to the same
    // staged file rather than accumulating copies; reusing
    // oversized-exif-rotated.jpg here would land on the SAME hashed filename
    // as the Before pick above and never produce one more thumbnail. A
    // second, distinct fixture image is required to exercise two real
    // uploads.
    thumbCountBefore = await waitForStableThumbCount();
    await mediaDialog.locator('input[type="file"]').setInputFiles("fixtures/tiny-second-image.jpg");
    await expect(mediaThumbs).toHaveCount(thumbCountBefore + 1);
    await mediaThumbs.last().click();
    await mediaDialog.getByRole("button", { name: "Use this image" }).click();
    await expect(mediaDialog).toBeHidden();
    await addDialog.getByRole("button", { name: "Next" }).click();

    await addDialog.locator("input[type='text']").first().fill("Lip Filler");
    let patchAccepted = waitForNextDraftPatchAccepted(page);
    await addDialog.getByRole("button", { name: "Save" }).click();
    await patchAccepted;
    await expect(addDialog).toBeHidden();

    const cards = slidersCollection.locator(".wx-section-card");
    await expect(cards).toHaveCount(1);
    await expect(cards.first().locator(".wx-section-field-input").first()).toHaveValue("Lip Filler");

    // The card list's own thumbnail render (renderImageSlot) is a REAL bug
    // this suite never caught: `img.src` was set from the raw content-JSON
    // src ("images/<hash>.jpg", no leading slash) instead of running it
    // through mediaDialog.ts's contentSrcToDisplayUrl() -- broken on any
    // non-root admin route (`/admin/section/<id>`), which is every real
    // route this panel is ever loaded from. `naturalWidth > 0` proves the
    // browser actually fetched and decoded the image, not just that an
    // <img> tag with SOME src exists in the DOM.
    for (const thumb of await cards.first().locator(".wx-section-image-thumb").all()) {
      await expect(thumb).toHaveJSProperty("complete", true);
      expect(await thumb.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    }

    // -- Pair #2: pick already-uploaded / pre-existing media, no re-upload --
    await slidersCollection.locator(".wx-section-add-button").click();
    await expect(addDialog).toBeVisible();
    await addDialog.getByRole("button", { name: "Choose Before photo" }).click();
    await expect(mediaDialog).toBeVisible();
    await mediaDialog.locator(".wx-media-thumb").first().click();
    await mediaDialog.getByRole("button", { name: "Use this image" }).click();
    await addDialog.getByRole("button", { name: "Next" }).click();

    await addDialog.getByRole("button", { name: "Choose After photo" }).click();
    await expect(mediaDialog).toBeVisible();
    await mediaDialog.locator(".wx-media-thumb").nth(1).click();
    await mediaDialog.getByRole("button", { name: "Use this image" }).click();
    await addDialog.getByRole("button", { name: "Next" }).click();

    await addDialog.locator("input[type='text']").first().fill("Cheek Filler");
    patchAccepted = waitForNextDraftPatchAccepted(page);
    await addDialog.getByRole("button", { name: "Save" }).click();
    await patchAccepted;

    await expect(cards).toHaveCount(2);
    await expect(cards.nth(1).locator(".wx-section-field-input").first()).toHaveValue("Cheek Filler");

    // -- retitle pair #1 -------------------------------------------------------
    const firstTitleInput = cards.first().locator(".wx-section-field-input").first();
    patchAccepted = waitForNextDraftPatchAccepted(page);
    await firstTitleInput.fill("Lip Filler (Updated)");
    await firstTitleInput.blur();
    await patchAccepted;
    await expect(firstTitleInput).toHaveValue("Lip Filler (Updated)");

    // -- reorder via buttons: move pair #2 up -> [Cheek Filler, Lip Filler] --
    patchAccepted = waitForNextDraftPatchAccepted(page);
    await cards.nth(1).getByRole("button", { name: "Move up" }).click();
    await patchAccepted;
    await expect(cards.first().locator(".wx-section-field-input").first()).toHaveValue("Cheek Filler");
    await expect(cards.nth(1).locator(".wx-section-field-input").first()).toHaveValue("Lip Filler (Updated)");

    await publishAndWait(page);

    // "the built content/gallery.json gains the item WITH cat and images/...
    // srcs, and the rendered gallery page contains the new figure" — verified
    // via the LIVE RENDERED page (an HTTP-observable proxy for the build
    // having succeeded and materialized the new content), the same "output
    // reflects order/count" pattern collection-edit.spec.ts (E2E 4) uses.
    const liveResponse = await page.request.get("/gallery.html");
    expect(liveResponse.status()).toBe(200);
    const liveHtml = await liveResponse.text();
    expect(liveHtml).toContain("Cheek Filler");
    expect(liveHtml).toContain("Lip Filler (Updated)");
    expect(liveHtml.indexOf("Cheek Filler")).toBeLessThan(liveHtml.indexOf("Lip Filler (Updated)"));
    expect(liveHtml).toMatch(/data-cat="lips"/);
    expect(liveHtml).toMatch(/src="images\/[^"]+\.jpe?g"/);

    expect(consoleErrors).toEqual([]);
  });

  test("align a photo pair: drag + micro nudge, save, publish — the live page serves the baked aligned photo", async ({
    page,
  }) => {
    // The journey Purdi asked for (decisions/00108): she added a pair whose
    // two photos don't line up; she must be able to fix that herself. Real
    // canvas, real bake, real upload pipeline, real publish — no mocks.
    const consoleErrors = trackConsoleErrors(page);

    await gotoSectionAndWaitReady(page, "before-after", "gallery");

    const slidersCollection = page.locator(".wx-section-collection", { hasText: "Drag-to-compare photos" });
    const addDialog = page.locator(".wx-section-add-dialog");
    const mediaDialog = page.locator(".wx-media-dialog-backdrop");
    const mediaThumbs = mediaDialog.locator(".wx-media-thumb");
    async function waitForStableThumbCount(): Promise<number> {
      await expect(mediaThumbs.first()).toBeVisible();
      return mediaThumbs.count();
    }

    // The suite shares ONE fixture server across spec files and this journey
    // runs after the main one, which PUBLISHED two pairs — the collection is
    // NOT empty here. Never assert an absolute count; my pair appends last.
    const cards = slidersCollection.locator(".wx-section-card");
    const countBefore = await cards.count();

    // -- One pair, two genuinely distinct uploads (the content-hash dedupe in
    // process_upload makes a same-file reuse land on the same staged name).
    await slidersCollection.locator(".wx-section-add-button").click();
    await expect(addDialog).toBeVisible();
    await addDialog.getByRole("button", { name: "Choose Before photo" }).click();
    await expect(mediaDialog).toBeVisible();
    let thumbCountBefore = await waitForStableThumbCount();
    await mediaDialog.locator('input[type="file"]').setInputFiles("fixtures/oversized-exif-rotated.jpg");
    await expect(mediaThumbs).toHaveCount(thumbCountBefore + 1);
    await mediaThumbs.last().click();
    await mediaDialog.getByRole("button", { name: "Use this image" }).click();
    await expect(mediaDialog).toBeHidden();
    await addDialog.getByRole("button", { name: "Next" }).click();

    await addDialog.getByRole("button", { name: "Choose After photo" }).click();
    await expect(mediaDialog).toBeVisible();
    thumbCountBefore = await waitForStableThumbCount();
    await mediaDialog.locator('input[type="file"]').setInputFiles("fixtures/tiny-second-image.jpg");
    await expect(mediaThumbs).toHaveCount(thumbCountBefore + 1);
    await mediaThumbs.last().click();
    await mediaDialog.getByRole("button", { name: "Use this image" }).click();
    await expect(mediaDialog).toBeHidden();
    await addDialog.getByRole("button", { name: "Next" }).click();

    await addDialog.locator("input[type='text']").first().fill("Alignment Test Pair");
    let patchAccepted = waitForNextDraftPatchAccepted(page);
    await addDialog.getByRole("button", { name: "Save" }).click();
    await patchAccepted;

    await expect(cards).toHaveCount(countBefore + 1);
    const myCard = cards.nth(countBefore);
    const afterThumb = myCard.locator(".wx-section-image-thumb").nth(1);
    const originalAfterSrc = await afterThumb.getAttribute("src");

    // -- Open the aligner from the card --------------------------------------
    await myCard.getByRole("button", { name: "Line up photos" }).click();
    const alignDialog = page.locator(".wx-align-dialog");
    await expect(alignDialog).toBeVisible();
    // Both photos must actually load before anything can work.
    await expect(alignDialog.locator(".wx-align-canvas-note")).toBeHidden();

    const saveButton = alignDialog.getByRole("button", { name: "Save aligned photo" });
    await expect(saveButton).toBeDisabled(); // nothing adjusted yet

    // Drag the photo with the "finger" (mouse-driven pointer events — the
    // same pointerdown/move/up stream a touch produces).
    const canvas = alignDialog.locator(".wx-align-canvas");
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) throw new Error("no canvas box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 12, { steps: 6 });
    await page.mouse.up();
    await expect(saveButton).toBeEnabled();

    // Then the micro pad for the fine adjustment (the operator's explicit ask).
    await alignDialog.getByRole("button", { name: "Nudge left" }).click();

    // Save: bake on the canvas, upload through the real media pipeline, and
    // the panel commits the whole array with the new photo. (No "Saving…"
    // busy-text assertion here: on localhost the whole bake→upload→commit
    // chain can complete within one Playwright tick, closing the dialog
    // before any post-click read — the dialog's close IS the success signal.)
    patchAccepted = waitForNextDraftPatchAccepted(page);
    await saveButton.click();
    await patchAccepted;
    await expect(alignDialog).toBeHidden();

    // The card's after photo is now a NEW staged upload (the original stays
    // in the media library, unused but hers).
    const alignedSrc = await afterThumb.getAttribute("src");
    expect(alignedSrc).not.toBe(originalAfterSrc);
    expect(alignedSrc).toMatch(/^\/admin\/draft-media\/[0-9a-f]{8}-.*-aligned\.jpg$/);
    await expect(afterThumb).toHaveJSProperty("complete", true);
    expect(await afterThumb.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

    // -- Publish: the live page serves the baked, aligned photo ---------------
    await publishAndWait(page);
    const liveResponse = await page.request.get("/gallery.html");
    expect(liveResponse.status()).toBe(200);
    const liveHtml = await liveResponse.text();
    expect(liveHtml).toMatch(/src="images\/[0-9a-f]{8}-[^"]*-aligned\.jpg"/);

    expect(consoleErrors).toEqual([]);
  });

  test("an intentionally-broken sliders array is rejected by the write gate (422), draft rev unchanged", async ({
    request,
  }) => {
    const stateBefore = (await (await request.get("/api/admin/state")).json()) as {
      draft: { rev: number };
    };

    // Missing `title` (a required key, `gallery-slider.schema.json`) violates
    // the draft-write gate's STRUCTURAL check (type/required/properties/
    // additionalProperties) — draft_validate.py's own docstring: this tier
    // deliberately SKIPS `pattern` (a blank `src` is a valid in-progress draft
    // state, only caught at PUBLISH-preflight time, decisions/00095), so a
    // missing key — not a blank string — is what a draft-time PATCH rejects.
    const response = await request.patch("/api/admin/draft", {
      data: {
        expectedRev: stateBefore.draft.rev,
        ops: [
          {
            file: "gallery",
            path: "gallery.sliders",
            value: [
              {
                cat: "lips",
                sub: "x",
                before: { src: "images/hero.jpg", alt: "x" },
                after: { src: "images/hero.jpg", alt: "x" },
              },
            ],
          },
        ],
      },
    });

    expect(response.status()).toBe(422);

    const stateAfter = (await (await request.get("/api/admin/state")).json()) as {
      draft: { rev: number };
    };
    expect(stateAfter.draft.rev).toBe(stateBefore.draft.rev);
  });
});
