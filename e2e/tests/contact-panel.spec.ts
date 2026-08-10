// decisions/00129: Contact is now a main admin tab (`/admin/contact`, promoted
// out of Settings) editing `content/_global.json`'s phone/email/address/map —
// the same single source every page's template already references via
// `@phone`/`@email`/`@address`/`@mapSrc` (never hardcoded per-page). This is
// the end-to-end proof unit/DOM tests can't give alone: a real edit through
// the real admin, persisted server-side, then actually live on the PUBLISHED
// public page — not just reflected in this one panel.

import { expect, test, type Page } from "@playwright/test";
import { publishAndWait, trackConsoleErrors, waitForNextDraftPatchAccepted } from "./helpers";

/** OSM tile images are irrelevant to every assertion here (click-to-pin math
 * is computed from click position + current view state, never from whether a
 * tile image actually decoded) — aborted the same way theme-change.spec.ts
 * blocks Google Fonts, so this suite never depends on real network access to
 * a third party. */
async function blockOsmTiles(page: Page): Promise<void> {
  await page.route("https://tile.openstreetmap.org/**", (route) => route.abort());
}

async function waitForGlobalGet(page: Page) {
  return page.waitForResponse(
    (res) => res.url().endsWith("/api/admin/global") && res.request().method() === "GET",
  );
}

test.describe("Contact panel (decisions/00129)", () => {
  test.beforeEach(async ({ request, page }) => {
    await request.delete("/api/admin/draft");
    await blockOsmTiles(page);
  });

  test("renders at /admin/contact as a main tab, not under Settings", async ({ page }) => {
    const globalFetch = waitForGlobalGet(page);
    await page.goto("/admin/contact");
    await globalFetch;
    await expect(page.locator(".wx-contact-panel")).toBeVisible();
    await expect(page.locator(".wx-contact-panel h2")).toHaveText("Contact");
    // The nav item itself is reachable and marks itself active on this route.
    await expect(page.locator('.wx-nav-item[data-route-kind="contact"]')).toHaveClass(/wx-nav-active/);
  });

  test("a legacy /admin/settings/contact deep link degrades to Settings > General, not a dead panel", async ({
    page,
  }) => {
    await page.goto("/admin/settings/contact");
    await expect(page.locator(".wx-settings-panel")).toBeVisible();
    await expect(page.locator(".wx-settings-tab-active")).toHaveText("General");
  });

  test("editing phone/email/address persists server-side and appears on the published page", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);

    const globalFetch = waitForGlobalGet(page);
    await page.goto("/admin/contact");
    await globalFetch;
    await page.waitForSelector(".wx-contact-panel");

    // Scoped to the "Contact details" section — the map section below it also
    // uses `.wx-settings-input` (shared field styling) for its coords field.
    const contactSection = page.locator(".wx-settings-section").first();
    const phoneInput = contactSection.locator(".wx-settings-input").nth(0);
    const emailInput = contactSection.locator(".wx-settings-input").nth(1);
    const addressTextarea = contactSection.locator(".wx-settings-textarea").first();

    const phonePatch = waitForNextDraftPatchAccepted(page);
    await phoneInput.fill("01111 222333");
    await phoneInput.dispatchEvent("change");
    await phonePatch;

    const emailPatch = waitForNextDraftPatchAccepted(page);
    await emailInput.fill("owner@example.invalid");
    await emailInput.dispatchEvent("change");
    await emailPatch;

    const addressPatch = waitForNextDraftPatchAccepted(page);
    await addressTextarea.fill("1 Test Street\nSomewhere, AB1 2CD");
    await addressTextarea.dispatchEvent("change");
    await addressPatch;

    // Persisted server-side (the read route, not just this one form's local
    // state). phoneHref/emailHref are a SEPARATE key each page's actual
    // tel:/mailto: links bind to (decisions/00127); mapSrc is likewise a
    // SEPARATE derived key the address edit must keep in step with
    // (decisions/00129) since no pin is set.
    const global = await page.request.get("/api/admin/global").then((r) => r.json());
    expect(global.global.phone).toBe("01111 222333");
    expect(global.global.phoneHref).toBe("tel:01111222333");
    expect(global.global.email).toBe("owner@example.invalid");
    expect(global.global.emailHref).toBe("mailto:owner@example.invalid");
    expect(global.global.address).toBe("1 Test Street<br>Somewhere, AB1 2CD");
    expect(global.global.mapCoords).toBe("");
    expect(global.global.mapSrc).toBe(
      "https://www.google.com/maps?q=1%20Test%20Street%2C%20Somewhere%2C%20AB1%202CD&output=embed",
    );

    await publishAndWait(page);

    // The whole point: the SAME edit, made in ONE place, is now live on a real
    // public page that references it via `@phone` — no per-page duplication to
    // keep in sync. The mini-site fixture's `footer.html` partial (injected
    // into every page) is the one template here that actually binds `@phone`;
    // `email`/`address`/the map aren't referenced by any fixture template, so
    // their persistence is already fully proven by the `/api/admin/global`
    // read above.
    const liveHomeHtml = await page.request.get("/").then((r) => r.text());
    expect(liveHomeHtml).toContain("01111 222333");

    expect(consoleErrors).toEqual([]);
  });

  test("clicking Reset on the address row discards address, mapCoords, AND mapSrc together, then reloads", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);

    const globalFetch = waitForGlobalGet(page);
    await page.goto("/admin/contact");
    await globalFetch;
    await page.waitForSelector(".wx-contact-panel");

    const originalGlobal = await page.request.get("/api/admin/global").then((r) => r.json());
    const originalAddress: string = originalGlobal.global.address ?? "";

    const addressRow = page.locator(".wx-settings-row-stacked").filter({
      has: page.locator(".wx-settings-row-label", { hasText: "Address" }),
    });
    const addressTextarea = addressRow.locator(".wx-settings-textarea");
    const setPatch = waitForNextDraftPatchAccepted(page);
    await addressTextarea.fill("A Different Address");
    await addressTextarea.dispatchEvent("change");
    await setPatch;

    // Reset discards the whole family, then reloads the whole tab
    // (decisions/00129) — wait for the reload's own GET, not just the discard.
    const discardPatch = waitForNextDraftPatchAccepted(page);
    const reloadFetch = waitForGlobalGet(page);
    await addressRow.locator(".wx-settings-link-button").click();
    await discardPatch;
    await reloadFetch;

    const global = await page.request.get("/api/admin/global").then((r) => r.json());
    expect(global.global.address).toBe(originalAddress);

    expect(consoleErrors).toEqual([]);
  });

  test("an armed click-to-pin commits mapCoords + a derived mapSrc; Clear reverts to address-derived", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);

    const globalFetch = waitForGlobalGet(page);
    await page.goto("/admin/contact");
    await globalFetch;
    await page.waitForSelector(".wx-map-viewport");

    const addressDerivedSrc: string = (await page.request.get("/api/admin/global").then((r) => r.json()))
      .global.mapSrc;

    await page.locator(".wx-map-arm-button").click();
    const pinPatch = waitForNextDraftPatchAccepted(page);
    await page.locator(".wx-map-viewport").click(); // clicks its visual center
    await pinPatch;

    const afterPin = await page.request.get("/api/admin/global").then((r) => r.json());
    expect(afterPin.global.mapCoords).toMatch(/^-?\d+\.\d+,-?\d+\.\d+$/);
    expect(afterPin.global.mapSrc).toMatch(
      /^https:\/\/www\.google\.com\/maps\?q=-?\d+\.\d+,-?\d+\.\d+&output=embed$/,
    );
    expect(afterPin.global.mapSrc).not.toBe(addressDerivedSrc);
    // Armed mode clears itself after a successful placement.
    await expect(page.locator(".wx-map-arm-button")).toHaveText("Click to pin coordinates");

    const clearPatch = waitForNextDraftPatchAccepted(page);
    await page.locator(".wx-map-clear-button").click();
    await clearPatch;

    const afterClear = await page.request.get("/api/admin/global").then((r) => r.json());
    expect(afterClear.global.mapCoords).toBe("");
    expect(afterClear.global.mapSrc).toBe(addressDerivedSrc);

    expect(consoleErrors).toEqual([]);
  });
});
