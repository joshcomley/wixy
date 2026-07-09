// Shared helpers across E2E spec files (spec/08-testing-acceptance.md §2) —
// extracted here once a third spec needed the same "navigate to the edit view
// and wait for it to actually be ready" logic (previously duplicated in
// concurrent-editing.spec.ts alone).

import type { Page } from "@playwright/test";

export async function gotoEditAndWaitReady(page: Page, slug: string): Promise<void> {
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

export async function editTextField(page: Page, key: string, newValue: string): Promise<void> {
  const frame = page.frameLocator(".wx-preview-iframe");
  await frame.locator(`[data-wx="${key}"]`).click();
  const input = frame.locator(".wx-popover input, .wx-popover textarea").first();
  await input.fill(newValue);
  await input.press("Enter");
}

/** spec/08 §2: "Console errors anywhere in E2E = failure" — a real JS exception or
 * console.error() call from application code. "Failed to load resource: ..." is a
 * BROWSER-level network diagnostic Chromium emits for any non-2xx response
 * regardless of whether application code handles it correctly — filtering that one
 * diagnostic category keeps this check meaningful for flows that deliberately,
 * correctly provoke a non-2xx response (e.g. a rev-conflict 409, or an aborted
 * external font request this suite blocks on purpose). */
export function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().startsWith("Failed to load resource")) {
      errors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}

/** Waits for the NEXT `PATCH /api/admin/draft` this page makes to come back 200 —
 * the OpQueue's 300ms coalesce + network round trip is real time a test must not
 * race ahead of before checking server-side state (or, for a discard, before the
 * panel's own post-accept refetch has had a chance to re-render). */
export function waitForNextDraftPatchAccepted(page: Page): Promise<void> {
  return page
    .waitForResponse(
      (res) => res.url().endsWith("/api/admin/draft") && res.request().method() === "PATCH",
    )
    .then((res) => {
      if (res.status() !== 200) {
        throw new Error(`expected PATCH /api/admin/draft to 200, got ${res.status()}`);
      }
    });
}
