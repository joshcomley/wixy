// E2E for decisions/00091 — the browse-mode toggle (spec/05 §2 amendment): a
// mouse-icon button in the edit bar that, while on, makes every click in the
// preview just navigate (or do nothing) instead of opening the usual edit
// popovers. The point of the feature is the WHOLE flow staying inside ONE edit
// session: toggle on, click through several pages, land on the one you
// actually want, toggle off, and keep editing — no reload, no lost draft
// state — so this spec exercises that full loop rather than the toggle in
// isolation (unit-covered in editor/tests/overlay.test.ts and
// admin-ui/tests/editView.test.ts already).

import { expect, test } from "@playwright/test";
import { gotoEditAndWaitReady, trackConsoleErrors, waitForNextDraftPatchAccepted } from "./helpers";

test.describe("browse mode (decisions/00091)", () => {
  test.beforeEach(async ({ request }) => {
    await request.delete("/api/admin/draft");
  });

  test("toggling on lets you click through pages without opening a popover; toggling off resumes editing on the page you land on, in the same session", async ({
    page,
  }) => {
    const errors = trackConsoleErrors(page);
    await gotoEditAndWaitReady(page, "index");
    const frame = page.frameLocator(".wx-preview-iframe");

    const toggle = page.locator(".wx-browse-mode-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    // The header's @nav renders "About" as a data-wx-href-bound link (the CTA/
    // nav pattern) — normally that opens the link-edit popover on click; in
    // browse mode it must navigate instead, same as a plain content link.
    const aboutContentFetch = page.waitForResponse(
      (res) => res.url().includes("/api/admin/content/about") && res.request().method() === "GET",
    );
    await frame.locator("nav.primary a", { hasText: "About" }).click();
    await aboutContentFetch;
    // Same buffer gotoEditAndWaitReady uses for the content-fetch -> overlay
    // `init` postMessage hop before relying on the freshly-booted overlay.
    await page.waitForTimeout(150);

    await expect(page).toHaveURL(/\/admin\/edit\/about$/);
    await expect(frame.locator(".wx-popover")).toHaveCount(0);

    // Still in browse mode on the SECOND page too (init.browseMode carried the
    // toggle across the real iframe reload, not just the click that caused
    // it) — a bound TEXT element (no href) is simply inert, not editable.
    await frame.locator('[data-wx="intro.title"]').click();
    await expect(frame.locator(".wx-composer-input")).toHaveCount(0);

    // Untoggle and keep editing — same session, no reload, no lost draft state.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    const newTitle = "About, edited after browsing";
    const patchAccepted = waitForNextDraftPatchAccepted(page);
    await frame.locator('[data-wx="intro.title"]').click();
    const input = frame.locator(".wx-composer-input");
    await expect(input).toBeVisible();
    await input.fill(newTitle);
    await input.press("Control+Enter");
    await patchAccepted;

    await expect(frame.locator('[data-wx="intro.title"]')).toHaveText(newTitle);
    expect(errors).toEqual([]);
  });
});
