// E2E for decisions/00083+00084 — the 2026-07-21 mobile edit-chrome round:
// 1. The edit view opens on the USER'S OWN form factor (00084): phone →
//    mobile (even >480px CSS-width outliers), tablet → tablet, desktop →
//    desktop. Was: `<480px ? mobile : desktop` — "defaults to desktop always".
// 2. The ▾ chrome reveal shows the menu BETWEEN the topbar and the pinned
//    slim bar (00084) — it used to slide an EMPTY gap open above while the
//    menu appeared below the slim bar.
// 3. The composer is pinned to the VISUAL viewport (00084) — page scroll,
//    keyboard, and pinch can never scroll it off irrecoverably; the outer
//    shell ignores pinch-zoom entirely (app chrome, "rock solid, immovable").
// 4. The preview document gets interactive-widget=resizes-content at overlay
//    startup (00084) and the composer maximize toggle is a real SVG (00084).

import { expect, test, type Page } from "@playwright/test";
import { gotoEditAndWaitReady, trackConsoleErrors } from "./helpers";

test.describe("device auto-detect (decisions/00084)", () => {
  const cases: Array<{ name: string; width: number; touch: boolean; expected: string }> = [
    { name: "phone 390", width: 390, touch: true, expected: "Mobile" },
    { name: "phone 487 (display-size outlier)", width: 487, touch: true, expected: "Mobile" },
    { name: "tablet 820", width: 820, touch: true, expected: "Tablet" },
    { name: "desktop 1280", width: 1280, touch: false, expected: "Desktop" },
  ];
  for (const c of cases) {
    test(`${c.name} opens in ${c.expected} view`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: c.width, height: 844 },
        isMobile: c.touch,
        hasTouch: c.touch,
        deviceScaleFactor: c.touch ? 3 : 1,
      });
      const page = await context.newPage();
      const errors = trackConsoleErrors(page);
      await gotoEditAndWaitReady(page, "index");
      const active = page.locator(".wx-device-group button.wx-device-active");
      await expect(active).toHaveText(c.expected);
      expect(errors).toEqual([]);
      await context.close();
    });
  }
});

test.describe("chrome reveal placement (decisions/00084)", () => {
  test("the menu reveals between the topbar and the pinned slim bar, with the topbar painted", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoEditAndWaitReady(page, "index");
    await page.locator(".wx-chrome-reveal").click();
    await page.waitForTimeout(700); // let the slide finish

    const rects = await page.evaluate(() => {
      const r = (sel: string) => {
        const el = document.querySelector(sel);
        if (el === null) return null;
        const b = el.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom };
      };
      const title = document.querySelector(".wx-topbar-title");
      return {
        topbar: r(".wx-topbar"),
        nav: r(".wx-nav"),
        host: r(".wx-edit-bar-host"),
        topbarVisibility: getComputedStyle(document.querySelector(".wx-topbar") as Element).visibility,
        titleVisible:
          title !== null &&
          getComputedStyle(title).visibility === "visible" &&
          title.getBoundingClientRect().height > 0,
      };
    });
    expect(rects.titleVisible, "topbar must paint, not slide open as an empty gap").toBe(true);
    expect(rects.topbarVisibility).toBe("visible");
    expect(rects.nav!.top).toBeGreaterThanOrEqual(rects.topbar!.bottom - 1);
    expect(rects.nav!.bottom).toBeLessThanOrEqual(rects.host!.top + 1);
    expect(errors).toEqual([]);
  });
});

test.describe("composer immovability (decisions/00084)", () => {
  async function openComposerAndScroll(page: Page): Promise<void> {
    await gotoEditAndWaitReady(page, "index");
    const frame = page.frameLocator(".wx-preview-iframe");
    await frame.locator('[data-wx="hero.title"]').first().click();
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const f = document.querySelector(".wx-preview-iframe") as HTMLIFrameElement;
      f.contentWindow?.scrollTo(0, 1200);
    });
    await page.waitForTimeout(300);
  }

  test("the preview document carries interactive-widget=resizes-content", async ({ page }) => {
    await gotoEditAndWaitReady(page, "index");
    const meta = await page.evaluate(() => {
      const f = document.querySelector(".wx-preview-iframe") as HTMLIFrameElement;
      return f.contentDocument?.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "";
    });
    expect(meta).toContain("interactive-widget=resizes-content");
  });

  test("stays pinned at the visible bottom after the page scrolls, at 390 and 320", async ({ page }) => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: Math.round(width * 2.16) });
      await openComposerAndScroll(page);
      const gap = await page.evaluate(() => {
        const f = document.querySelector(".wx-preview-iframe") as HTMLIFrameElement;
        const doc = f.contentDocument!;
        const c = doc.querySelector(".wx-composer:not(.wx-control-sheet)")!;
        const fr = f.getBoundingClientRect();
        const cr = c.getBoundingClientRect();
        const s = fr.height / doc.defaultView!.innerHeight;
        return Math.abs(fr.top + cr.bottom * s - Math.min(fr.bottom, window.innerHeight));
      });
      expect(gap, `composer must hug the visible bottom at ${width}px`).toBeLessThan(3);
      await page.frameLocator(".wx-preview-iframe").locator(".wx-composer-cancel").click();
      await page.goto("/admin#/pages"); // reset route state for the next width
    }
  });

  test("the outer shell ignores pinch-zoom (edit chrome cannot be panned away)", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    const page = await context.newPage();
    await gotoEditAndWaitReady(page, "index");
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.synthesizePinchGesture", {
      x: 195,
      y: 400,
      scaleFactor: 2,
      gestureSourceType: "touch",
    });
    await page.waitForTimeout(400);
    const scale = await page.evaluate(() => window.visualViewport?.scale ?? 1);
    expect(scale).toBe(1);
    await context.close();
  });

  test("the maximize toggle is a real SVG icon", async ({ page }) => {
    await gotoEditAndWaitReady(page, "index");
    const frame = page.frameLocator(".wx-preview-iframe");
    await frame.locator('[data-wx="hero.title"]').first().click();
    const svg = frame.locator(".wx-composer-max-toggle svg");
    await expect(svg).toBeVisible();
    const box = await svg.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(12); // frame-internal px (scaled ≤1 on screen)
  });
});
