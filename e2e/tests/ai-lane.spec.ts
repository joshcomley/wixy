// E2E 6 (spec/08-testing-acceptance.md §2): "AI lane (faked): fake cmd 'ships' a
// commit to the temp origin's main (fixture script) → draft preview banner appears
// → publish drawer lists the upstream commit → publish includes it live."
//
// Milestone 10 (AI chat, cmdchat.py) doesn't exist yet, so "fake cmd ships a commit"
// is simulated the same way this flow's own name says: a fixture-only endpoint
// (`fixture_server.py`'s `/test/simulate-upstream-commit`, never imported by product
// code) pushes straight to the bare site origin (decisions/00030's bare-origin fix)
// and fetches the checkout forward itself, exactly as a real AI-lane merge would
// land one — deliberately NOT relying on (or lowering, suite-wide) the real
// staleness-triggered fetch on `GET /admin/preview/{page}.html` (spec/04 §7,
// decisions/00030's OTHER fix, closing a real spec-vs-reality gap): that
// mechanism is for an upstream commit arriving with no other signal, and this
// fixture endpoint has a much stronger one (it just pushed the commit itself).

import { expect, test } from "@playwright/test";
import { gotoEditAndWaitReady, publishAndWait, trackConsoleErrors } from "./helpers";

test.describe("E2E 6: AI lane (faked)", () => {
  test.beforeEach(async ({ request }) => {
    await request.delete("/api/admin/draft");
  });

  test("an upstream commit appears in the draft chip and publish drawer, and publishing includes it live", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);

    const shipResponse = await page.request.post("/test/simulate-upstream-commit", {
      data: { title: "AI Lane Change" },
    });
    expect(shipResponse.status()).toBe(200);

    await gotoEditAndWaitReady(page, "index");

    // "draft preview banner appears" — the draft-status chip surfaces upstream
    // commits (shell.ts's renderTopBar: "N unpublished change(s)", plus "· M site
    // update(s)" once there are any — layman wording, decisions/00081).
    await expect(page.locator(".wx-draft-chip")).toHaveText("1 site update");

    // "publish drawer lists the upstream commit" — opened and closed again
    // (rather than confirming from here) so `publishAndWait` below opens a
    // fresh drawer itself; the draft chip toggles, it doesn't just open (and
    // it's the visible trigger in edit view — decisions/00076).
    await page.click(".wx-draft-chip");
    await page.waitForSelector(".wx-publish-confirm");
    await expect(page.locator(".wx-diff-upstream")).toContainText("1 update made outside the editor");
    await expect(page.locator(".wx-diff-upstream")).toContainText("AI: AI Lane Change");
    await expect(page.locator(".wx-diff-upstream")).toContainText("AI Lane");
    await page.click(".wx-drawer-close");

    // "publish includes it live"
    await publishAndWait(page);
    const liveResponse = await page.request.get("/");
    expect(liveResponse.status()).toBe(200);
    expect(await liveResponse.text()).toContain("AI Lane Change");

    // Bonus, per spec/04 §5's source-kind classification: a publish with zero
    // draft ops riding purely on an upstream commit is attributed to "AI", not
    // "editor" — the history panel's author column reflects it.
    await page.goto("/admin#/history");
    await expect(page.locator("table.wx-history-table")).toContainText("AI");

    expect(consoleErrors).toEqual([]);
  });
});
