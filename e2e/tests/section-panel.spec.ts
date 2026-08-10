// E2E (decisions/00098): the registry-configured admin section editor — the
// Before & After photo-pair editor `ca.json` declares for its `gallery` page.
// The E2E fixture (`fixture_server.py:_write_gallery_page`) adds a REAL
// `gallery` page + `content/gallery.json` using the SAME `gallery.sliders`/
// `gallery.tiles` collection paths and schemas `builder.collections.
// COLLECTION_RULES` registers in production (from PR 1) — so the write gate,
// publish pipeline, and rendering are all exercised for real here, not faked.
//
// decisions/00118: this panel now holds edits LOCALLY until an explicit Save
// (staged-save model) — an edit no longer PATCHes the draft by itself, so
// every journey below inserts a `saveSectionPanel` step wherever the
// pre-decisions/00118 version waited on the PATCH directly.
//
// Full owner journey: add a photo pair (uploading two images through the
// guided dialog), add a second pair (picking already-uploaded media), retitle,
// reorder via the ↑/↓ buttons, Save, publish, and assert the built output. Plus
// the publish-blocked write-gate journey (brief explicitly allows skipping the
// drawer-blocked -> Fix-it-for-me -> publishable UI combo here — PR 1's own
// suite already covers that; this just confirms the SAME 1c gate rejects a
// structurally-invalid write through this new panel's content path too), and
// the staged-save UX itself (unsaved -> Save -> ready to publish -> Publish;
// Undo/Discard at both stages).

import { expect, test, type Locator, type Page } from "@playwright/test";
import { publishAndWait, trackConsoleErrors, waitForNextDraftPatchAccepted } from "./helpers";

/** Finds the `.wx-section-card` whose title input's current VALUE is `title`.
 * `Locator.filter({ hasText })` matches textContent (or a form control's
 * accessible NAME, from its `<label>`) — never an `<input>`'s value, so it
 * can't find a card by its title text (Playwright's own guidance: prefer
 * `inputValue()` for form controls over textContent-based matching).
 *
 * Polls via `expect(...).toPass()` rather than a one-shot count+scan
 * (decisions/00118): the panel's `load()` now fetches `/api/admin/content`
 * AND `/api/admin/state` concurrently (the ready-to-publish banner's
 * opCount), so the card grid can still read "Loading…" for a beat after
 * `gotoSectionAndWaitReady`'s own content-fetch wait resolves — a bare
 * `.count()` read right then can race ahead of the render. */
async function findCardByTitle(collection: Locator, title: string): Promise<Locator> {
  const cards = collection.locator(".wx-section-card");
  await expect(async () => {
    const count = await cards.count();
    let found = false;
    for (let i = 0; i < count; i++) {
      const value = await cards.nth(i).locator(".wx-section-field-input").first().inputValue();
      if (value === title) {
        found = true;
        break;
      }
    }
    expect(found, `no .wx-section-card found with title "${title}"`).toBe(true);
  }).toPass({ timeout: 5000 });

  const count = await cards.count();
  for (let i = 0; i < count; i++) {
    const candidate = cards.nth(i);
    const value = await candidate.locator(".wx-section-field-input").first().inputValue();
    if (value === title) return candidate;
  }
  throw new Error(`no .wx-section-card found with title "${title}" (unreachable — toPass already confirmed it)`);
}

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

/** Clicks the panel-level Save bar's Save button (decisions/00118) — distinct
 * from the guided add-flow's / aligner's OWN "Save" buttons, which only
 * finish that dialog and stage the result locally; this is what actually
 * writes the whole array to the draft via the shared `OpQueue`, the same
 * `PATCH /api/admin/draft` every other admin edit ultimately goes through. */
async function saveSectionPanel(page: Page): Promise<void> {
  const patchAccepted = waitForNextDraftPatchAccepted(page);
  await page.click(".wx-section-save-button");
  await patchAccepted;
}

test.describe("E2E: registry-configured section editor (Before & After)", () => {
  test.beforeEach(async ({ request }) => {
    await request.delete("/api/admin/draft");
  });

  test("add a photo pair (uploading two images), add a second (picking existing media), retitle, reorder via buttons, Save, publish, and the output reflects it", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);

    await gotoSectionAndWaitReady(page, "before-after", "gallery");

    const slidersCollection = page.locator(".wx-section-collection", { hasText: "Drag-to-compare photos" });
    // The fixture seeds sliders with one HIDDEN pair (fixture_server.py's
    // "Hidden Pair", visible: false — see the PR 1 toggle tests below), so the
    // empty-state message is exercised via the tiles collection instead,
    // which genuinely starts empty.
    const tilesCollection = page.locator(".wx-section-collection", { hasText: "Tap-to-zoom photos" });
    await expect(tilesCollection.locator(".wx-section-empty")).toHaveText(
      "No photos yet — add your first photo.",
    );

    const addDialog = page.locator(".wx-section-add-dialog");
    const mediaDialog = page.locator(".wx-media-dialog-backdrop");
    const saveBar = page.locator(".wx-section-save-bar");
    const saveButton = page.locator(".wx-section-save-button");

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
    // The wizard's OWN Save only finishes the item and stages it locally
    // (decisions/00118) — no PATCH yet, and the panel-level Save bar appears.
    await addDialog.getByRole("button", { name: "Save" }).click();
    await expect(addDialog).toBeHidden();
    await expect(saveBar).toBeVisible();
    await expect(saveButton).toBeEnabled();

    // Index 0 is always the fixture's pre-seeded "Hidden Pair" (born first in
    // the array); everything this journey adds lands after it. This is a
    // pure DOM/local-state check — it doesn't need the panel-level Save yet.
    const cards = slidersCollection.locator(".wx-section-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(1).locator(".wx-section-field-input").first()).toHaveValue("Lip Filler");
    await expect(cards.nth(1)).toHaveClass(/wx-section-card-dirty/);
    await expect(cards.nth(1).locator(".wx-section-unsaved-badge")).toHaveText("Unsaved");

    // The card list's own thumbnail render (renderImageSlot) is a REAL bug
    // this suite never caught: `img.src` was set from the raw content-JSON
    // src ("images/<hash>.jpg", no leading slash) instead of running it
    // through mediaDialog.ts's contentSrcToDisplayUrl() -- broken on any
    // non-root admin route (`/admin/section/<id>`), which is every real
    // route this panel is ever loaded from. `naturalWidth > 0` proves the
    // browser actually fetched and decoded the image, not just that an
    // <img> tag with SOME src exists in the DOM.
    for (const thumb of await cards.nth(1).locator(".wx-section-image-thumb").all()) {
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
    await addDialog.getByRole("button", { name: "Save" }).click();
    await expect(addDialog).toBeHidden();

    await expect(cards).toHaveCount(3);
    await expect(cards.nth(2).locator(".wx-section-field-input").first()).toHaveValue("Cheek Filler");

    // -- retitle pair #1 (still local — batching several edits before the
    // one Save that ships them all is exactly the point of the new model) --
    const firstTitleInput = cards.nth(1).locator(".wx-section-field-input").first();
    await firstTitleInput.fill("Lip Filler (Updated)");
    await firstTitleInput.blur();
    await expect(firstTitleInput).toHaveValue("Lip Filler (Updated)");

    // -- reorder via buttons: move pair #2 up -> [Cheek Filler, Lip Filler] --
    await cards.nth(2).getByRole("button", { name: "Move up" }).click();
    await expect(cards.nth(1).locator(".wx-section-field-input").first()).toHaveValue("Cheek Filler");
    await expect(cards.nth(2).locator(".wx-section-field-input").first()).toHaveValue("Lip Filler (Updated)");

    // -- Save: everything above ships as ONE batch, then "ready to publish" --
    await saveSectionPanel(page);
    await expect(saveBar).toBeHidden();
    await expect(page.locator(".wx-section-ready-banner")).toBeVisible();
    await expect(page.locator(".wx-section-ready-banner-text")).toContainText("ready to publish");

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
    // The fixture's pre-seeded hidden pair must stay off the public page
    // through this whole unrelated add/reorder/publish journey.
    expect(liveHtml).not.toContain("Hidden Pair");

    expect(consoleErrors).toEqual([]);
  });

  test("clean URLs: /gallery serves the same content as /gallery.html; /gallery/ 404s (decisions/00128)", async ({
    page,
  }) => {
    // The bootstrap publish (fixture_server.py:_publish_initial_build) materializes a
    // live build before the server ever starts, so this needs no photo-upload/publish
    // choreography of its own — it only exercises routes_public.py's resolution
    // contract against whatever's currently live. `/gallery.html` is kept working
    // forever (decisions/00128) alongside the other tests in this file that request it
    // directly — this is the dedicated coverage for the extensionless shape + the
    // deliberate trailing-slash 404 (GitHub Pages parity, verified live).
    const [cleanResponse, htmlResponse, trailingSlashResponse] = await Promise.all([
      page.request.get("/gallery"),
      page.request.get("/gallery.html"),
      page.request.get("/gallery/"),
    ]);
    expect(cleanResponse.status()).toBe(200);
    expect(htmlResponse.status()).toBe(200);
    expect(await cleanResponse.text()).toBe(await htmlResponse.text());
    expect(trailingSlashResponse.status()).toBe(404);
  });

  test("align a photo pair: drag + micro nudge, save, publish — the live page serves the baked aligned photo", async ({
    page,
  }) => {
    // The journey Purdi asked for (decisions/00111): she added a pair whose
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
    // Wait for the first card to actually paint before reading `.count()`
    // (decisions/00118: `load()` now also awaits a concurrent `/api/admin/
    // state` fetch for the ready-to-publish banner, so the grid can still
    // read "Loading…" for a beat after `gotoSectionAndWaitReady` returns —
    // a bare, non-retrying `.count()` right then can read 0).
    const cards = slidersCollection.locator(".wx-section-card");
    await expect(cards.first()).toBeVisible();
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
    await addDialog.getByRole("button", { name: "Save" }).click();
    await expect(addDialog).toBeHidden();

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

    const alignSaveButton = alignDialog.getByRole("button", { name: "Save aligned photo" });
    await expect(alignSaveButton).toBeDisabled(); // nothing adjusted yet

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
    await expect(alignSaveButton).toBeEnabled();

    // Then the micro pad for the fine adjustment (the operator's explicit ask).
    await alignDialog.getByRole("button", { name: "Nudge left" }).click();

    // Save: bake on the canvas, upload through the real media pipeline, and
    // the panel STAGES the whole array with the new photo locally
    // (decisions/00118 — no PATCH yet). (No "Saving…" busy-text assertion
    // here: on localhost the whole bake→upload→stage chain can complete
    // within one Playwright tick, closing the dialog before any post-click
    // read — the dialog's close IS the completion signal.)
    await alignSaveButton.click();
    await expect(alignDialog).toBeHidden();

    // The card's after photo is now a NEW staged upload (the original stays
    // in the media library, unused but hers) — a local DOM read, no save
    // needed yet.
    const alignedSrc = await afterThumb.getAttribute("src");
    expect(alignedSrc).not.toBe(originalAfterSrc);
    expect(alignedSrc).toMatch(/^\/admin\/draft-media\/[0-9a-f]{8}-.*-aligned\.jpg$/);
    await expect(afterThumb).toHaveJSProperty("complete", true);
    expect(await afterThumb.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

    // -- Save, then publish: the live page serves the baked, aligned photo --
    await saveSectionPanel(page);
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
    // This test drives the SERVER's write gate directly (Playwright's API
    // request context, not the admin UI) — decisions/00118's staged-save
    // model is a client-side concern and doesn't change this contract.
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

  test("a sliders array with visible: false on an item is ACCEPTED by the write gate (PR 1)", async ({
    request,
  }) => {
    // Companion to the 422 test above: `visible` is now a schema-legal
    // property (builder/schemas/gallery-slider.schema.json), so an otherwise
    // well-formed item carrying it must NOT be rejected by the structural
    // draft-write gate.
    const stateBefore = (await (await request.get("/api/admin/state")).json()) as {
      draft: { rev: number };
    };

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
                title: "x",
                sub: "x",
                before: { src: "images/hero.jpg", alt: "x" },
                after: { src: "images/hero.jpg", alt: "x" },
                visible: false,
              },
            ],
          },
        ],
      },
    });

    expect(response.status()).toBe(200);
  });

  test("PR 2: toggling the Show-on-site header switch for a hidden pair, Saving, and publishing makes it live; toggling off and publishing removes it again", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);

    await gotoSectionAndWaitReady(page, "before-after", "gallery");
    const slidersCollection = page.locator(".wx-section-collection", { hasText: "Drag-to-compare photos" });
    const hiddenCard = await findCardByTitle(slidersCollection, "Hidden Pair");
    await expect(hiddenCard).toBeVisible();
    await expect(hiddenCard).toHaveClass(/wx-section-card-hidden/);
    await expect(hiddenCard.locator(".wx-section-visibility-text")).toHaveText(
      "Hidden — not on your site yet. Turn on to add it.",
    );
    // The old small pill is gone entirely (decisions/00119) — the header bar's
    // plain wording above replaces it.
    await expect(hiddenCard.locator(".wx-section-hidden-chip")).toHaveCount(0);
    const toggle = hiddenCard.locator(".wx-switch-input");
    await expect(toggle).not.toBeChecked();

    // Baseline: it has never been published visible, so it's absent from the
    // live page from the very start.
    let liveHtml = await (await page.request.get("/gallery.html")).text();
    expect(liveHtml).not.toContain("Hidden Pair");

    // -- switch ON, Save, publish, and it appears live -----------------------
    await toggle.check();
    await expect(hiddenCard).not.toHaveClass(/wx-section-card-hidden/);
    await expect(hiddenCard.locator(".wx-section-visibility-text")).toHaveText("Shown on your site");
    await expect(page.locator(".wx-section-save-bar")).toBeVisible();

    await saveSectionPanel(page);

    // A publish success re-reads the mounted panel's collection in the
    // background (`SectionPanel.refresh()`, decisions/00115) — its OWN `GET
    // /api/admin/content/gallery` fetch. Wait for that specific request to
    // land before the next edit: `toBeChecked()` alone doesn't prove
    // anything here (this item is already checked either side of the
    // refresh), and a still-in-flight refresh, if it resolves AFTER the next
    // edit's optimistic render, clobbers the DOM back to what it fetched
    // before that edit ever happened.
    const refreshFetched = page.waitForResponse(
      (res) =>
        res.url().includes("/api/admin/content/gallery") && res.request().method() === "GET",
    );
    await publishAndWait(page);
    await refreshFetched;
    liveHtml = await (await page.request.get("/gallery.html")).text();
    expect(liveHtml).toContain("Hidden Pair");

    // publishAndWait leaves the drawer open on its success state (every OTHER
    // caller either publishes once, or navigates between two calls —
    // restore.spec.ts's own re-navigation happens to close it); a second call
    // in the same test needs it closed first or the drawer intercepts the
    // status bar's Publish button.
    await page.click(".wx-drawer-close");

    // -- switch back OFF, Save, publish, and it's gone again -----------------
    await toggle.uncheck();
    await expect(hiddenCard).toHaveClass(/wx-section-card-hidden/);
    await saveSectionPanel(page);

    await publishAndWait(page);
    liveHtml = await (await page.request.get("/gallery.html")).text();
    expect(liveHtml).not.toContain("Hidden Pair");

    expect(consoleErrors).toEqual([]);
  });

  test("PR 3: the inline before/after preview drags to compare, and tap-to-enlarge opens a bigger read-only version", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);
    await gotoSectionAndWaitReady(page, "before-after", "gallery");
    const slidersCollection = page.locator(".wx-section-collection", { hasText: "Drag-to-compare photos" });
    // "Hidden Pair" has both a before and an after photo (fixture seed) —
    // read/drag-only here, never published, so reusing it is safe (matches
    // the other read-only journeys in this file, e.g. Undo/Discard above).
    const card = await findCardByTitle(slidersCollection, "Hidden Pair");

    const preview = card.locator(".wx-before-after");
    await expect(preview).toBeVisible();
    const range = preview.locator(".wx-before-after-range");
    const before = preview.locator(".wx-before-after-before");
    // Exact clip-path string formatting is already precisely covered by the
    // unit suite (beforeAfterSlider.test.ts, a deterministic jsdom
    // environment) — this just proves the real browser wiring (drag ->
    // input event -> visible clip change) works end to end.
    await expect(before).toHaveCSS("clip-path", /50%/);

    await range.evaluate((el: HTMLInputElement) => {
      el.value = "80";
      el.dispatchEvent(new Event("input"));
    });
    await expect(before).toHaveCSS("clip-path", /20%/);
    await expect(range).toHaveValue("80");

    // Tap-to-enlarge: a SEPARATE, independently-draggable larger instance in
    // a modal — no editing controls. (The aligner, "Line up photos", is a
    // completely separate button/flow this never touches — decisions/00119;
    // its own drag/save/publish journey is covered by the test above.)
    await card.locator(".wx-section-before-after-expand").click();
    const modal = page.locator(".wx-before-after-modal-backdrop");
    await expect(modal).toBeVisible();
    await expect(modal.locator(".wx-before-after")).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();

    expect(consoleErrors).toEqual([]);
  });

  test("PR 3: a tile (single image field) never gets a fabricated before/after preview", async ({ page }) => {
    await gotoSectionAndWaitReady(page, "before-after", "gallery");
    const tilesCollection = page.locator(".wx-section-collection", { hasText: "Tap-to-zoom photos" });
    await expect(tilesCollection.locator(".wx-before-after")).toHaveCount(0);
  });
});

test.describe("E2E: section editor staged-save model (decisions/00118)", () => {
  test.beforeEach(async ({ request }) => {
    await request.delete("/api/admin/draft");
  });

  test("edit -> visibly unsaved, Save enables -> Save -> ready to publish -> Publish; the shell chip matches", async ({
    page,
  }) => {
    // Uses a FRESH, disposable tile (never the shared "Hidden Pair" slider
    // fixture item other tests in this file also rely on by title) — this
    // journey PUBLISHES for real, which is a permanent mutation on the
    // fixture server every other spec in the SAME run shares.
    const consoleErrors = trackConsoleErrors(page);
    await gotoSectionAndWaitReady(page, "before-after", "gallery");

    const saveButton = page.locator(".wx-section-save-button");
    const saveBar = page.locator(".wx-section-save-bar");
    const readyBanner = page.locator(".wx-section-ready-banner");
    const chip = page.locator(".wx-draft-chip");

    // Clean start: no Save bar, Save disabled, chip quiet.
    await expect(saveBar).toBeHidden();
    await expect(saveButton).toBeDisabled();
    await expect(chip).toHaveText("Nothing to publish");

    const tilesCollection = page.locator(".wx-section-collection", { hasText: "Tap-to-zoom photos" });
    const addDialog = page.locator(".wx-section-add-dialog");
    const mediaDialog = page.locator(".wx-media-dialog-backdrop");
    await tilesCollection.locator(".wx-section-add-button").click();
    await expect(addDialog).toBeVisible();
    await addDialog.getByRole("button", { name: "Choose Photo" }).click();
    await expect(mediaDialog).toBeVisible();
    await mediaDialog.locator(".wx-media-thumb").first().click();
    await mediaDialog.getByRole("button", { name: "Use this image" }).click();
    // Photo picked -> the image step re-renders with a preview + an enabled
    // "Next"; it does NOT auto-advance to the form step.
    await addDialog.getByRole("button", { name: "Next" }).click();
    await addDialog.locator("input[type='text']").first().fill("Staged Save Journey Tile");
    // The wizard's own Save only finishes the item and stages it locally
    // (decisions/00118) — the panel is ALREADY dirty the moment it closes.
    await addDialog.getByRole("button", { name: "Save" }).click();
    await expect(addDialog).toBeHidden();

    const card = await findCardByTitle(tilesCollection, "Staged Save Journey Tile");
    const titleInput = card.locator(".wx-section-field-input").first();

    // Visibly unsaved.
    await expect(saveBar).toBeVisible();
    await expect(saveButton).toBeEnabled();
    await expect(card).toHaveClass(/wx-section-card-dirty/);
    await expect(card.locator(".wx-section-unsaved-badge")).toHaveText("Unsaved");

    // A second local edit, batched into the SAME Save.
    await titleInput.fill("Staged Save Journey Tile (Retitled)");
    await titleInput.blur();
    await expect(titleInput).toHaveClass(/wx-field-dirty/);

    // Save -> ready to publish, and the global chip agrees.
    await saveSectionPanel(page);
    await expect(saveBar).toBeHidden();
    await expect(readyBanner).toBeVisible();
    await expect(readyBanner.locator(".wx-section-ready-banner-text")).toContainText(
      "ready to publish",
    );
    await expect(chip).toContainText("ready to publish");
    const retitledInput = card.locator(".wx-section-field-input").first();
    await expect(retitledInput).not.toHaveClass(/wx-field-dirty/);
    await expect(retitledInput).toHaveValue("Staged Save Journey Tile (Retitled)");

    // Publish from the panel's own banner (auto-saves anything unsaved first
    // — nothing is here, but this exercises the panel's own trigger, not just
    // the global status bar).
    await readyBanner.getByRole("button", { name: "Publish" }).click();
    await page.waitForSelector(".wx-publish-confirm");
    const publishResponse = page.waitForResponse(
      (res) => res.url().endsWith("/api/admin/publish") && res.request().method() === "POST",
    );
    await page.click(".wx-publish-confirm");
    await publishResponse;
    await page.waitForSelector(".wx-publish-state-caption:has-text('Version')");

    expect(consoleErrors).toEqual([]);
  });

  test("Undo last reverts a local edit without writing anything, and the save bar clears", async ({
    page,
  }) => {
    await gotoSectionAndWaitReady(page, "before-after", "gallery");
    const slidersCollection = page.locator(".wx-section-collection", { hasText: "Drag-to-compare photos" });
    const hiddenCard = await findCardByTitle(slidersCollection, "Hidden Pair");
    const titleInput = hiddenCard.locator(".wx-section-field-input").first();

    await titleInput.fill("Oops Wrong Title");
    await titleInput.blur();
    await expect(page.locator(".wx-section-save-bar")).toBeVisible();

    await page.click(".wx-section-undo-button");

    await expect(page.locator(".wx-section-save-bar")).toBeHidden();
    await expect(hiddenCard.locator(".wx-section-field-input").first()).toHaveValue("Hidden Pair");

    const stateAfter = (await (await page.request.get("/api/admin/state")).json()) as {
      draft: { opCount: number };
    };
    expect(stateAfter.draft.opCount).toBe(0);
  });

  test("Discard unsaved reverts every local edit back to the last-saved state, with confirmation", async ({
    page,
  }) => {
    await gotoSectionAndWaitReady(page, "before-after", "gallery");
    const slidersCollection = page.locator(".wx-section-collection", { hasText: "Drag-to-compare photos" });
    const hiddenCard = await findCardByTitle(slidersCollection, "Hidden Pair");
    const titleInput = hiddenCard.locator(".wx-section-field-input").first();

    await titleInput.fill("Oops Wrong Title");
    await titleInput.blur();
    await expect(page.locator(".wx-section-save-bar")).toBeVisible();

    page.once("dialog", (dialog) => void dialog.accept());
    await page.click(".wx-section-discard-unsaved-button");

    await expect(page.locator(".wx-section-save-bar")).toBeHidden();
    await expect(hiddenCard.locator(".wx-section-field-input").first()).toHaveValue("Hidden Pair");
  });

  test("Discard all changes wipes a SAVED (but not yet published) draft back to zero, with confirmation", async ({
    page,
  }) => {
    await gotoSectionAndWaitReady(page, "before-after", "gallery");
    const slidersCollection = page.locator(".wx-section-collection", { hasText: "Drag-to-compare photos" });
    const hiddenCard = await findCardByTitle(slidersCollection, "Hidden Pair");
    const titleInput = hiddenCard.locator(".wx-section-field-input").first();

    await titleInput.fill("About To Be Discarded");
    await titleInput.blur();
    await saveSectionPanel(page);

    await expect(page.locator(".wx-section-ready-banner")).toBeVisible();
    const stateAfterSave = (await (await page.request.get("/api/admin/state")).json()) as {
      draft: { opCount: number };
    };
    expect(stateAfterSave.draft.opCount).toBeGreaterThan(0);

    page.once("dialog", (dialog) => void dialog.accept());
    await page.click(".wx-section-discard-all-button");
    await expect(page.locator(".wx-section-ready-banner")).toBeHidden();

    const stateAfterDiscard = (await (await page.request.get("/api/admin/state")).json()) as {
      draft: { opCount: number };
    };
    expect(stateAfterDiscard.draft.opCount).toBe(0);
    await expect(page.locator(".wx-draft-chip")).toHaveText("Nothing to publish");
    // Reverted, not deleted — the seeded item is back to its original title.
    const revertedCard = await findCardByTitle(slidersCollection, "Hidden Pair");
    await expect(revertedCard).toBeVisible();
  });

  test("navigating away (in-app nav) with unsaved edits prompts; declining keeps her on the section with the edit intact", async ({
    page,
  }) => {
    // A real `page.goto()` would exercise the browser's native beforeunload
    // dialog instead (a different, notoriously flaky-under-automation code
    // path) — this targets the IN-APP SPA route guard (shell.ts's
    // `handleRoute`), so it drives navigation the same way a real click on
    // the nav bar does: `navigateTo()` -> `popstate`.
    await gotoSectionAndWaitReady(page, "before-after", "gallery");
    const slidersCollection = page.locator(".wx-section-collection", { hasText: "Drag-to-compare photos" });
    const hiddenCard = await findCardByTitle(slidersCollection, "Hidden Pair");
    const titleInput = hiddenCard.locator(".wx-section-field-input").first();

    await titleInput.fill("Don't Lose Me");
    await titleInput.blur();

    page.once("dialog", (dialog) => void dialog.dismiss());
    await page.click('.wx-nav-item[data-route-kind="pages"]');

    // Declined -> still on the section route, edit intact, URL unchanged.
    await expect(page.locator(".wx-section-panel")).toBeVisible();
    await expect(page.locator(".wx-section-field-input").first()).toHaveValue("Don't Lose Me");
    expect(page.url()).toContain("/admin/section/before-after");
  });

  test("navigating away (in-app nav) with unsaved edits, once confirmed, leaves the section route", async ({
    page,
  }) => {
    await gotoSectionAndWaitReady(page, "before-after", "gallery");
    const slidersCollection = page.locator(".wx-section-collection", { hasText: "Drag-to-compare photos" });
    const hiddenCard = await findCardByTitle(slidersCollection, "Hidden Pair");
    const titleInput = hiddenCard.locator(".wx-section-field-input").first();

    await titleInput.fill("Leaving Anyway");
    await titleInput.blur();

    page.once("dialog", (dialog) => void dialog.accept());
    await page.click('.wx-nav-item[data-route-kind="pages"]');

    await expect(page.locator(".wx-pages-panel")).toBeVisible();
    expect(page.url()).toContain("/admin/pages");
  });

  test("PR 2: Turn all off then Turn all on (with confirmation) bulk-toggles every item in a collection", async ({
    page,
  }) => {
    // Two FRESH disposable tiles (never "Hidden Pair" or any other test's own
    // published items) — draft-only for the whole test (stage + Save, never
    // Publish), so the describe block's `beforeEach` (`DELETE /api/admin/
    // draft`) leaves nothing behind regardless of run order (the lesson from
    // the OTHER staged-save tests above, which safely reuse "Hidden Pair" the
    // same way).
    await gotoSectionAndWaitReady(page, "before-after", "gallery");
    const tilesCollection = page.locator(".wx-section-collection", { hasText: "Tap-to-zoom photos" });
    const addDialog = page.locator(".wx-section-add-dialog");
    const mediaDialog = page.locator(".wx-media-dialog-backdrop");

    async function addTile(title: string): Promise<void> {
      await tilesCollection.locator(".wx-section-add-button").click();
      await expect(addDialog).toBeVisible();
      await addDialog.getByRole("button", { name: "Choose Photo" }).click();
      await expect(mediaDialog).toBeVisible();
      await mediaDialog.locator(".wx-media-thumb").first().click();
      await mediaDialog.getByRole("button", { name: "Use this image" }).click();
      await addDialog.getByRole("button", { name: "Next" }).click();
      await addDialog.locator("input[type='text']").first().fill(title);
      await addDialog.getByRole("button", { name: "Save" }).click();
      await expect(addDialog).toBeHidden();
    }

    await addTile("Turn All Test A");
    await addTile("Turn All Test B");
    const cardA = await findCardByTitle(tilesCollection, "Turn All Test A");
    const cardB = await findCardByTitle(tilesCollection, "Turn All Test B");

    // Both born shown (decisions/00118's wizard default, unchanged by PR2).
    await expect(cardA.locator(".wx-switch-input")).toBeChecked();
    await expect(cardB.locator(".wx-switch-input")).toBeChecked();

    page.once("dialog", (dialog) => void dialog.accept());
    await tilesCollection.getByRole("button", { name: "Turn all off" }).click();

    await expect(cardA.locator(".wx-switch-input")).not.toBeChecked();
    await expect(cardB.locator(".wx-switch-input")).not.toBeChecked();
    await expect(cardA).toHaveClass(/wx-section-card-hidden/);
    await expect(cardB).toHaveClass(/wx-section-card-hidden/);
    await expect(cardA.locator(".wx-section-visibility-text")).toHaveText(
      "Hidden — not on your site yet. Turn on to add it.",
    );

    page.once("dialog", (dialog) => void dialog.accept());
    await tilesCollection.getByRole("button", { name: "Turn all on" }).click();

    await expect(cardA.locator(".wx-switch-input")).toBeChecked();
    await expect(cardB.locator(".wx-switch-input")).toBeChecked();
    await expect(cardA).not.toHaveClass(/wx-section-card-hidden/);
    await expect(cardB).not.toHaveClass(/wx-section-card-hidden/);
    await expect(cardA.locator(".wx-section-visibility-text")).toHaveText("Shown on your site");

    // Declining leaves everything exactly as it was.
    page.once("dialog", (dialog) => void dialog.dismiss());
    await tilesCollection.getByRole("button", { name: "Turn all off" }).click();
    await expect(cardA.locator(".wx-switch-input")).toBeChecked();
    await expect(cardB.locator(".wx-switch-input")).toBeChecked();

    await saveSectionPanel(page);
  });
});
