// E2E 3 (spec/08-testing-acceptance.md §2): "Theme: change `clay` + headings font →
// iframe vars update live → publish → theme.css + fonts link reflect it."
//
// The mini-site fixture's theme.json (builder/tests/fixtures/mini-site/theme/
// theme.json) has no `clay` key — that's the real Cottage Aesthetics palette (spec/02
// §4's example), not this fixture's deliberately-minimal one — so this substitutes
// `cream` (a real key this fixture DOES have) for the same test intent: prove a
// color change live-applies. "Headings" = the `serif` role (admin-ui/src/
// themePanel.ts's FONT_ROLES mapping, confirmed against the real CA site.css's own
// usage per decisions/00021).
//
// Only the EDITING-side half is built here — the publish-tail half ("theme.css +
// fonts link reflect it" on the PUBLISHED site) needs milestone 9's publisher,
// matching decisions/00015 decision 4's established E2E 1/4 caveat.
//
// Google Fonts requests are blocked (spec/08 §1: "never hit the real network") —
// this test asserts the fonts <link> href updates correctly, not that the family
// actually renders (which would require real internet access this suite must not
// depend on).

import { expect, test } from "@playwright/test";
import { trackConsoleErrors, waitForNextDraftPatchAccepted } from "./helpers";

test.describe("E2E 3: theme change", () => {
  test.beforeEach(async ({ request }) => {
    await request.delete("/api/admin/draft");
  });

  test("changing a color and the headings font live-applies to the embedded preview", async ({
    page,
  }) => {
    await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
    const consoleErrors = trackConsoleErrors(page);

    const themeFetch = page.waitForResponse(
      (res) => res.url().includes("/api/admin/theme") && res.request().method() === "GET",
    );
    await page.goto("/admin#/theme");
    await themeFetch;
    await page.waitForSelector(".wx-theme-panel");

    const frame = page.frameLocator(".wx-preview-iframe");
    await frame.locator("body").waitFor();

    // -- Color: cream --
    const creamHex = page
      .locator(".wx-theme-color-row")
      .filter({ has: page.locator(".wx-theme-color-label", { hasText: "cream" }) })
      .locator(".wx-theme-hex");
    const creamPatch = waitForNextDraftPatchAccepted(page);
    await creamHex.fill("#00AA33");
    await creamHex.dispatchEvent("change");

    await page.waitForFunction(() => {
      const iframe = document.querySelector("iframe.wx-preview-iframe") as HTMLIFrameElement | null;
      const doc = iframe?.contentDocument;
      return doc?.documentElement.style.getPropertyValue("--cream").trim() === "#00AA33";
    });
    await creamPatch;

    // -- Font: Headings (serif role) --
    const headingsRow = page
      .locator(".wx-theme-font-row")
      .filter({ has: page.locator("h4", { hasText: "Headings" }) });
    const familyInput = headingsRow.locator(".wx-theme-font-family");
    const fontPatch = waitForNextDraftPatchAccepted(page);
    await familyInput.fill("Playfair Display");
    await familyInput.dispatchEvent("change");

    await page.waitForFunction(() => {
      const iframe = document.querySelector("iframe.wx-preview-iframe") as HTMLIFrameElement | null;
      const doc = iframe?.contentDocument;
      const varValue = doc?.documentElement.style.getPropertyValue("--font-serif").trim();
      return varValue?.includes("Playfair Display") ?? false;
    });
    await fontPatch;

    // The fonts <link> href swapped too (not just the CSS var) — a family change
    // needs the actual stylesheet resource, which a CSS custom property alone
    // can't fetch (decisions/00021 decision 3).
    const fontsLinkHref = await frame
      .locator('link[rel="stylesheet"][href*="fonts.googleapis.com"]')
      .getAttribute("href");
    expect(fontsLinkHref).toContain("Playfair+Display");

    // Persisted server-side, not just applied to this one iframe optimistically.
    const theme = await page.request.get("/api/admin/theme").then((r) => r.json());
    expect(theme.theme.colors.cream).toBe("#00AA33");
    expect(theme.theme.fonts.serif.family).toBe("Playfair Display");

    expect(consoleErrors).toEqual([]);
  });

  test("reset to published reverts a color and re-applies the checkout value live", async ({
    page,
  }) => {
    await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
    const consoleErrors = trackConsoleErrors(page);

    const themeFetch = page.waitForResponse(
      (res) => res.url().includes("/api/admin/theme") && res.request().method() === "GET",
    );
    await page.goto("/admin#/theme");
    await themeFetch;
    await page.waitForSelector(".wx-theme-panel");

    const creamHex = page
      .locator(".wx-theme-color-row")
      .filter({ has: page.locator(".wx-theme-color-label", { hasText: "cream" }) })
      .locator(".wx-theme-hex");
    const setPatch = waitForNextDraftPatchAccepted(page);
    await creamHex.fill("#123456");
    await creamHex.dispatchEvent("change");
    await setPatch;

    const creamRow = page
      .locator(".wx-theme-color-row")
      .filter({ has: page.locator(".wx-theme-color-label", { hasText: "cream" }) });
    const discardPatch = waitForNextDraftPatchAccepted(page);
    await creamRow.locator(".wx-theme-reset").click();
    await discardPatch;

    // The discard round-trips through the server (decisions/00021 decision 7: the
    // panel can't compute the reverted value client-side) before the hex field
    // and the live iframe var both reflect the ORIGINAL checkout value again —
    // `onOpsAccepted`'s refetch (also server round-trip time) still needs its own
    // wait even after the discard PATCH itself has come back. `renderSections()`
    // fully rebuilds every row on refetch, so re-scope to the cream row specifically
    // rather than a bare ".wx-theme-hex" (which would match "coffee"'s row first —
    // `Object.keys(...).sort()` renders colors alphabetically).
    await expect(creamHex).toHaveValue("#F1E8D9");
    await page.waitForFunction(() => {
      const iframe = document.querySelector("iframe.wx-preview-iframe") as HTMLIFrameElement | null;
      const doc = iframe?.contentDocument;
      return doc?.documentElement.style.getPropertyValue("--cream").trim() === "#F1E8D9";
    });

    const theme = await page.request.get("/api/admin/theme").then((r) => r.json());
    expect(theme.theme.colors.cream).toBe("#F1E8D9");

    expect(consoleErrors).toEqual([]);
  });
});
