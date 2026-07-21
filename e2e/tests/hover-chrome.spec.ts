// E2E for decisions/00086 — content-anchored overlay chrome must scroll WITH
// the page. The selection chip ("TEXT") and the list item toolbar were
// position:fixed and pinned once at hover time, so scrolling the preview left
// them floating where the element USED to be while the (class-based) outline
// tracked the element perfectly — the operator's 2026-07-21 third report:
// "the outline stays in the right place but the 'text' tag isn't anchored
// properly to it". Both are now anchored in DOCUMENT coordinates (absolute),
// so any scroll moves them with the content by construction — no listeners.
//
// The tests run in TOUCH contexts and TAP, matching the operator's phone:
// touch has sticky-hover (tap-end fires no pointerout), so the chrome stays
// anchored to the tapped element; a programmatic scroll then fires NO re-hover
// (no mouse pointer sits over the document), so a glued measurement is clean.
// A desktop-mouse variant re-hovers the moment the scroll settles (the pointer
// lands on new content), which re-creates the chrome and poisons the compare.

import { expect, test, type Browser, type Page } from "@playwright/test";
import { gotoEditAndWaitReady, trackConsoleErrors } from "./helpers";

const FRAME = ".wx-preview-iframe";

async function newPhonePage(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

/** gap between the chrome's top and its anchor's bottom edge (must be constant
 * across any scroll), plus the anchor's viewport top (to prove it moved). */
async function chromeGap(
  page: Page,
  anchorSel: string,
  chromeSel: string,
): Promise<{ gap: number; anchorTop: number }> {
  return await page.evaluate(
    ({ anchorSel: a, chromeSel: c }) => {
      const doc = (document.querySelector(".wx-preview-iframe") as HTMLIFrameElement).contentDocument!;
      const anchor = doc.querySelector(a)!;
      const chrome = doc.querySelector(c)!;
      return {
        gap: chrome.getBoundingClientRect().top - anchor.getBoundingClientRect().bottom,
        anchorTop: anchor.getBoundingClientRect().top,
      };
    },
    { anchorSel, chromeSel },
  );
}

async function scrollPreview(page: Page): Promise<number> {
  const moved = await page.evaluate(() => {
    const w = (document.querySelector(".wx-preview-iframe") as HTMLIFrameElement).contentWindow!;
    const before = w.scrollY;
    w.scrollBy(0, 10_000); // clamped to the page's real max scroll
    return w.scrollY - before;
  });
  await page.waitForTimeout(250);
  return moved;
}

test.describe("content-anchored chrome (decisions/00086)", () => {
  test("the selection chip stays glued to its element when the preview scrolls", async ({ browser }) => {
    const { page, close } = await newPhonePage(browser);
    const errors = trackConsoleErrors(page);
    await gotoEditAndWaitReady(page, "index");
    const frame = page.frameLocator(FRAME);
    // The operator's exact flow: tap some text (composer opens, chip shows)…
    await frame.locator('[data-wx="hero.title"]').first().tap();
    await expect(frame.locator(".wx-hover-chip")).toBeVisible();
    const before = await chromeGap(page, '[data-wx="hero.title"]', ".wx-hover-chip");
    // …then scroll the website. The element really moves…
    const moved = await scrollPreview(page);
    const after = await chromeGap(page, '[data-wx="hero.title"]', ".wx-hover-chip");
    expect(moved, "the preview must actually scroll for this test to mean anything").toBeGreaterThan(50);
    // …and the chip must move WITH it, not stay behind.
    expect(Math.abs(after.gap - before.gap), "chip must stay glued to its element on scroll").toBeLessThan(2);
    expect(errors).toEqual([]);
    await close();
  });

  test("the list item toolbar stays glued to its item when the preview scrolls", async ({ browser }) => {
    const { page, close } = await newPhonePage(browser);
    const errors = trackConsoleErrors(page);
    await gotoEditAndWaitReady(page, "index");
    const frame = page.frameLocator(FRAME);
    await frame.locator("[data-wx-list-item]").first().tap();
    await expect(frame.locator(".wx-item-toolbar")).toBeVisible();
    const before = await chromeGap(page, "[data-wx-list-item]", ".wx-item-toolbar");
    const moved = await scrollPreview(page);
    const after = await chromeGap(page, "[data-wx-list-item]", ".wx-item-toolbar");
    expect(moved, "the preview must actually scroll for this test to mean anything").toBeGreaterThan(50);
    expect(Math.abs(after.gap - before.gap), "item toolbar must stay glued to its item on scroll").toBeLessThan(2);
    expect(errors).toEqual([]);
    await close();
  });
});
