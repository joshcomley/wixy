// E2E 2 (spec/08-testing-acceptance.md §2): "Image replace: upload fixture JPEG
// (oversized, EXIF-rotated) → element updates → publish → file committed to repo
// images/, served, resized, EXIF-free."
//
// "Resized" and "EXIF-free" are asserted straight from the staged draft asset:
// both happen at UPLOAD time (wixy_server/media.py's process_upload, milestone 8
// slice 1), not at publish time, so they never needed milestone 9 to exist. The
// publish-tail half ("committed to repo images/") WAS deferred pending milestone
// 9's publisher (decisions/00015 decision 4, repeated for M8 in decisions/00020/
// 00021) — extended here now that it exists (decisions/00030), closing
// decisions/00023's own flagged "consider extending E2E 2/3" nice-to-have.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  gotoEditAndWaitReady,
  publishAndWait,
  trackConsoleErrors,
  waitForNextDraftPatchAccepted,
} from "./helpers";

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "oversized-exif-rotated.jpg",
);

test.describe("E2E 2: image replace", () => {
  test.beforeEach(async ({ request }) => {
    await request.delete("/api/admin/draft");
  });

  test("uploading an oversized, EXIF-rotated JPEG replaces the hero background, resized and EXIF-free", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);

    await gotoEditAndWaitReady(page, "index");
    const frame = page.frameLocator(".wx-preview-iframe");

    await frame.locator('[data-wx-bg="hero.bg"]').click();
    await frame.locator(".wx-popover button", { hasText: "Replace image" }).click();
    await page.waitForSelector(".wx-media-dialog-backdrop");

    await page.locator('input[type="file"]').setInputFiles(FIXTURE_PATH);
    // hero.jpg + icon.jpg (repo, from the mini-site fixture) + this upload.
    await page.waitForFunction(() => document.querySelectorAll(".wx-media-item").length >= 3);

    const draftThumb = page.locator(".wx-media-item:has(.wx-media-badge) .wx-media-thumb").first();
    await draftThumb.click();
    const bgPatch = waitForNextDraftPatchAccepted(page);
    await page.click('.wx-media-alt-step button:text("Use this image")');
    await page.waitForSelector(".wx-media-dialog-backdrop", { state: "detached" });
    // The overlay op (hero.bg -> the draft-media URL) must actually reach the
    // server, not just update the DOM optimistically — publish's materialize
    // step only copies media referenced by a REAL overlay op into images/.
    await bgPatch;

    // element updates (spec/08 §2's own wording) — the DOM background-image now
    // points at the freshly staged draft file.
    await page.waitForFunction(() => {
      const iframe = document.querySelector("iframe.wx-preview-iframe") as HTMLIFrameElement | null;
      const target = iframe?.contentDocument?.querySelector('[data-wx-bg="hero.bg"]');
      return target?.getAttribute("style")?.includes("draft-media") ?? false;
    });

    // Resized to the project's configured limit (mini-site fixture project config:
    // maxLongSidePx=2000) and genuinely re-oriented (the fixture is landscape as
    // STORED with an EXIF rotate-90 tag — after auto-orient + resize it must come
    // out portrait, narrower than tall, never the original 3000x2000).
    const media = await page.request.get("/api/admin/media").then((r) => r.json());
    const uploaded = media.media.find((m: { source: string }) => m.source === "draft");
    expect(uploaded).toBeDefined();
    expect(Math.max(uploaded.width, uploaded.height)).toBeLessThanOrEqual(2000);
    expect(uploaded.width).toBeLessThan(uploaded.height); // portrait, proving re-orientation

    // Actually servable (milestone 8 slice 3's decisions/00022 fix — a real gap
    // this exact assertion would have caught at the time) and EXIF-free (stripped
    // at upload time, wixy_server/media.py's process_upload).
    const assetResponse = await page.request.get(uploaded.url);
    expect(assetResponse.status()).toBe(200);
    const bytes = await assetResponse.body();
    // A JPEG EXIF (APP1) segment starts with FF E1 right after the FF D8 SOI marker
    // — the simplest reliable "no EXIF" check without a full JPEG-parsing library.
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(bytes[2] === 0xff && bytes[3] === 0xe1).toBe(false);

    // "publish → file committed to repo images/, served" (spec/08 §2's own
    // wording) — the draft-media URL rewrites to the published images/<name>
    // form (wixy_server/publisher.py's _rewrite_draft_media_refs).
    const mediaName: string = uploaded.url.split("/").pop();
    await publishAndWait(page);
    const publishedResponse = await page.request.get(`/images/${mediaName}`);
    expect(publishedResponse.status()).toBe(200);
    expect(await publishedResponse.body()).toEqual(bytes);
    const liveHtml = await page.request.get("/").then((r) => r.text());
    expect(liveHtml).toContain(`images/${mediaName}`);

    expect(consoleErrors).toEqual([]);
  });
});
