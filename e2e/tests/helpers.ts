// Shared helpers across E2E spec files (spec/08-testing-acceptance.md §2) —
// extracted here once a third spec needed the same "navigate to the edit view
// and wait for it to actually be ready" logic (previously duplicated in
// concurrent-editing.spec.ts alone).

import type { Page } from "@playwright/test";

export async function gotoEditAndWaitReady(page: Page, slug: string): Promise<void> {
  const contentFetch = page.waitForResponse(
    (res) => res.url().includes(`/api/admin/content/${slug}`) && res.request().method() === "GET",
  );
  const target = `/admin/edit/${slug}`;
  // A same-URL `goto` (including an IDENTICAL hash) is a browser no-op — no
  // navigation, no hashchange, so the SPA router never remounts the edit view
  // and the content fetch this function waits for never fires. A flow that
  // revisits the same page's edit route twice (e.g. E2E 5's restore flow,
  // decisions/00030) needs a genuine reload to see fresh server state.
  if (page.url().endsWith(target)) {
    await page.reload();
  } else {
    await page.goto(target);
  }
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
  // The text composer (decisions/00075): Enter is a newline now — commit is
  // Ctrl+Enter (or the ✓ button).
  const input = frame.locator(".wx-composer-input");
  await input.fill(newValue);
  await input.press("Control+Enter");
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

/** Waits for the NEXT `PATCH /api/admin/draft` this page makes to come back 200,
 * returning the new rev — the OpQueue's 300ms coalesce + network round trip is
 * real time a test must not race ahead of before checking server-side state (or,
 * for a discard, before the panel's own post-accept refetch has had a chance to
 * re-render). */
export function waitForNextDraftPatchAccepted(page: Page): Promise<number> {
  return page
    .waitForResponse(
      (res) => res.url().endsWith("/api/admin/draft") && res.request().method() === "PATCH",
    )
    .then(async (res) => {
      if (res.status() !== 200) {
        throw new Error(`expected PATCH /api/admin/draft to 200, got ${res.status()}`);
      }
      const body = (await res.json()) as { rev: number };
      return body.rev;
    });
}

const PUBLISH_CONFLICT_RETRY_LIMIT = 5;

/** Opens the publish drawer (the status bar's Publish button — spec/05 §5),
 * confirms, and waits for `POST /api/admin/publish` to come back 200, returning
 * the new version number. Every E2E flow that publishes (1, 4, 5, 6) needs this
 * exact sequence, so it's shared from the moment a SECOND flow needs it rather
 * than duplicated per spec file — unlike `gotoEditAndWaitReady`/`editTextField`/
 * `trackConsoleErrors` (decisions/00023 decision 2), which waited for a third
 * consumer, here all four consumers were already known up front.
 *
 * The trigger is the status bar's Publish button (decisions/00083): the slim,
 * always-visible unpublished-changes bar at the very top of the shell, shown
 * on EVERY route including the edit view (the old topbar Publish button hid
 * there; the draft chip no longer relocates into the slim edit bar either).
 * Retries on a 409 rev-conflict: every accepted PATCH fires a background,
 * un-awaited `GET /api/admin/state` (shell.ts's `refreshStateInBackground`, off
 * the OpQueue's `onAccepted`) that the drawer's `expectedRev` is built from —
 * chaining several edits with little else between them (as a real user rapidly
 * clicking through an item toolbar would, or as `waitForNextDraftPatchAccepted`
 * alone permits) can open the drawer on a STALE rev, since that background
 * refresh hasn't necessarily landed yet. Found via real-browser E2E
 * verification the moment a flow did more than one edit before publishing —
 * decisions/00030. A 409 here means exactly that race, not a real conflict (no
 * other actor touches this fixture's draft) — closing and reopening the drawer
 * re-reads whatever `state` is by then, which converges within a couple of
 * attempts. Any OTHER failure status fails loudly and immediately; every flow
 * using this expects the publish to eventually succeed. */
export async function publishAndWait(page: Page): Promise<number> {
  for (let attempt = 0; attempt < PUBLISH_CONFLICT_RETRY_LIMIT; attempt++) {
    await page.click(".wx-statusbar .wx-publish-button");
    await page.waitForSelector(".wx-publish-confirm");
    const publishResponse = page.waitForResponse(
      (res) => res.url().endsWith("/api/admin/publish") && res.request().method() === "POST",
    );
    await page.click(".wx-publish-confirm");
    const response = await publishResponse;
    if (response.status() === 200) {
      const body = (await response.json()) as { version: number };
      await page.waitForSelector(".wx-publish-progress:has-text('Published as version')");
      return body.version;
    }
    if (response.status() !== 409) {
      const body = await response.text();
      throw new Error(`expected POST /api/admin/publish to 200, got ${response.status()}: ${body}`);
    }
    await page.click(".wx-drawer-close");
    await page.waitForTimeout(200);
  }
  throw new Error(
    `publishAndWait: still 409-ing after ${PUBLISH_CONFLICT_RETRY_LIMIT} attempts`,
  );
}
