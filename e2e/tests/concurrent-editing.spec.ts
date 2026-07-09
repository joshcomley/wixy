// E2E 8 (spec/08-testing-acceptance.md §2): "Concurrent editing sanity: two admin
// tabs, edits in both, no lost ops (rev/replay)." The ONE of the three E2E flows M7
// is scoped against that doesn't need milestone 9's publisher (decisions/00015
// decision 4) — E2E 1 and 4 need a real publish step to fully pass and aren't built
// as Playwright tests yet.

import { expect, test, type Page } from "@playwright/test";

async function gotoEditAndWaitReady(page: Page, slug: string): Promise<void> {
  const contentFetch = page.waitForResponse(
    (res) => res.url().includes(`/api/admin/content/${slug}`) && res.request().method() === "GET",
  );
  await page.goto(`/admin#/edit/${slug}`);
  await contentFetch;
  // The content response is what triggers the shell's `init` postMessage to the
  // overlay (editView.ts's requestInit) — a small buffer covers that last, very
  // fast (same-document postMessage) hop before the overlay's `state` is set,
  // which direct (non-item-scoped) op emission needs to target the right page.
  await page.waitForTimeout(150);
}

async function editTextField(page: Page, key: string, newValue: string): Promise<void> {
  const frame = page.frameLocator(".wx-preview-iframe");
  await frame.locator(`[data-wx="${key}"]`).click();
  const input = frame.locator(".wx-popover input, .wx-popover textarea").first();
  await input.fill(newValue);
  await input.press("Enter");
}

test.describe("E2E 8: concurrent editing sanity", () => {
  test.beforeEach(async ({ request }) => {
    await request.delete("/api/admin/draft"); // every flow starts from a clean draft
  });

  test("two tabs editing different fields on the same page — neither op is lost", async ({
    context,
  }) => {
    const tabA = await context.newPage();
    const tabB = await context.newPage();

    // spec/08 §2: "Console errors anywhere in E2E = failure" — a real JS exception
    // or console.error() call from application code. "Failed to load resource: ...
    // 409" is a BROWSER-level network diagnostic Chromium emits for ANY non-2xx
    // response regardless of whether application code handles it correctly — and
    // this flow deliberately, correctly provokes a 409 as the whole point of
    // testing rev/replay. Filtering that one diagnostic category is what keeps this
    // check meaningful (catching real regressions) instead of unsatisfiable by any
    // test that exercises a request the app is SUPPOSED to reject.
    const consoleErrors: string[] = [];
    for (const page of [tabA, tabB]) {
      page.on("console", (msg) => {
        if (msg.type() === "error" && !msg.text().startsWith("Failed to load resource")) {
          consoleErrors.push(msg.text());
        }
      });
      page.on("pageerror", (err) => consoleErrors.push(String(err)));
    }

    const patchResponses: { tab: string; status: number }[] = [];
    tabA.on("response", (res) => {
      if (res.url().endsWith("/api/admin/draft") && res.request().method() === "PATCH") {
        patchResponses.push({ tab: "A", status: res.status() });
      }
    });
    tabB.on("response", (res) => {
      if (res.url().endsWith("/api/admin/draft") && res.request().method() === "PATCH") {
        patchResponses.push({ tab: "B", status: res.status() });
      }
    });

    // Tab A's PATCH is artificially delayed so it deterministically arrives at
    // the server AFTER tab B's — forcing the rev-conflict/replay path spec/08
    // §2 exists to prove, rather than hoping real-world timing happens to race
    // on any given CI run.
    await tabA.route("**/api/admin/draft", async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.continue();
    });

    await gotoEditAndWaitReady(tabA, "index");
    await gotoEditAndWaitReady(tabB, "index");

    await Promise.all([
      editTextField(tabA, "hero.title", "Edited by Tab A"),
      editTextField(tabB, "hero.tag", "Edited by Tab B"),
    ]);

    // Coalesce (300ms) + tab A's injected 700ms delay + a 409 + refetch-rev +
    // replay (itself delayed another 700ms by the same route handler) — give
    // it generous headroom on a possibly-slower CI runner.
    await tabA.waitForTimeout(3000);

    const state = await tabA.request.get("/api/admin/state").then((r) => r.json());
    expect(state.draft.opCount).toBe(2);

    const content = await tabA.request.get("/api/admin/content/index").then((r) => r.json());
    expect(content.content.hero.title).toBe("Edited by Tab A");
    expect(content.content.hero.tag).toBe("Edited by Tab B");

    // Proof the rev-conflict/replay path was actually exercised, not just that
    // both edits happened to land without ever colliding.
    expect(patchResponses.some((r) => r.tab === "A" && r.status === 409)).toBe(true);
    expect(patchResponses.some((r) => r.tab === "A" && r.status === 200)).toBe(true);
    expect(patchResponses.some((r) => r.tab === "B" && r.status === 200)).toBe(true);

    expect(consoleErrors).toEqual([]);
  });
});
