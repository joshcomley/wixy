// decisions/00127: Settings > Contact edits `content/_global.json`'s
// phone/email/address — the same single source every page's template
// already references via `@phone`/`@email`/`@address` (never hardcoded
// per-page). This is the end-to-end proof unit/DOM tests can't give alone:
// a real edit through the real admin, persisted server-side, then actually
// live on the PUBLISHED public page — not just reflected in this one panel.

import { expect, test } from "@playwright/test";
import { publishAndWait, trackConsoleErrors, waitForNextDraftPatchAccepted } from "./helpers";

test.describe("Settings > Contact (decisions/00127)", () => {
  test.beforeEach(async ({ request }) => {
    await request.delete("/api/admin/draft");
  });

  test("editing phone/email/address persists server-side and appears on the published page", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);

    const globalFetch = page.waitForResponse(
      (res) => res.url().endsWith("/api/admin/global") && res.request().method() === "GET",
    );
    await page.goto("/admin/settings/contact");
    await globalFetch;
    await page.waitForSelector(".wx-settings-contact");

    const phoneInput = page.locator(".wx-settings-input").nth(0);
    const emailInput = page.locator(".wx-settings-input").nth(1);
    const addressTextarea = page.locator(".wx-settings-textarea").first();

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

    // Persisted server-side (the read route, not just this one form's local state).
    const global = await page.request.get("/api/admin/global").then((r) => r.json());
    expect(global.global.phone).toBe("01111 222333");
    expect(global.global.email).toBe("owner@example.invalid");
    expect(global.global.address).toBe("1 Test Street<br>Somewhere, AB1 2CD");

    await publishAndWait(page);

    // The whole point: the SAME edit, made in ONE place, is now live on a real
    // public page that references it via `@phone` — no per-page duplication to
    // keep in sync. The mini-site fixture's `footer.html` partial (injected
    // into every page) is the one template here that actually binds `@phone`;
    // `email`/`address` aren't referenced by any fixture template, so their
    // persistence is already fully proven by the `/api/admin/global` read
    // above — this only extends the proof to "and it reaches a real
    // published page" for the one field a template here can show.
    const liveHomeHtml = await page.request.get("/").then((r) => r.text());
    expect(liveHomeHtml).toContain("01111 222333");

    expect(consoleErrors).toEqual([]);
  });

  test("clicking Reset discards the staged edit and restores the published value", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);

    const originalGlobal = await page.request.get("/api/admin/global").then((r) => r.json());
    const originalPhone: string = originalGlobal.global.phone ?? "";

    const globalFetch = page.waitForResponse(
      (res) => res.url().endsWith("/api/admin/global") && res.request().method() === "GET",
    );
    await page.goto("/admin/settings/contact");
    await globalFetch;
    await page.waitForSelector(".wx-settings-contact");

    const phoneInput = page.locator(".wx-settings-input").nth(0);
    const setPatch = waitForNextDraftPatchAccepted(page);
    await phoneInput.fill("09999 888777");
    await phoneInput.dispatchEvent("change");
    await setPatch;

    const phoneRow = page.locator(".wx-settings-row-stacked").filter({
      has: page.locator(".wx-settings-row-label", { hasText: "Contact phone" }),
    });
    const discardPatch = waitForNextDraftPatchAccepted(page);
    await phoneRow.locator(".wx-settings-link-button").click();
    await discardPatch;

    await expect(phoneInput).toHaveValue(originalPhone);
    const global = await page.request.get("/api/admin/global").then((r) => r.json());
    expect(global.global.phone).toBe(originalPhone);

    expect(consoleErrors).toEqual([]);
  });
});
