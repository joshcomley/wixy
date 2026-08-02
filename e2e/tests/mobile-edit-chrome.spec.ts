// E2E for decisions/00083+00084+00107 — the mobile edit-chrome rounds:
// 1. The edit view opens on the USER'S OWN form factor (00084): phone →
//    mobile (even >480px CSS-width outliers), tablet → tablet, desktop →
//    desktop. Was: `<480px ? mobile : desktop` — "defaults to desktop always".
// 2. The ▾ chrome reveal shows the nav row (tabs + ⋯) BETWEEN the status bar
//    and the pinned slim bar (00084/00107) — it used to slide an EMPTY gap
//    open above while the menu appeared below the slim bar. Since 00107 the
//    topbar banner is gone entirely at phone widths (its overflow clip had
//    swallowed the ⋯ popover — "I tap the burger menu, nothing appears"),
//    and the ⋯ trigger pins to the right of the tab strip.
// 3. The composer is pinned to the VISUAL viewport (00084) — page scroll,
//    keyboard, and pinch can never scroll it off irrecoverably; the outer
//    shell ignores pinch-zoom entirely (app chrome, "rock solid, immovable").
// 4. The preview document gets interactive-widget=resizes-content at overlay
//    startup (00084) and the composer maximize toggle is a real SVG (00084).
// 5. The shell's ROOT document can never scroll (00085): 100vh sized the shell
//    to the LARGE viewport, so on a phone with the URL bar shown the shell was
//    taller than the visible area and the whole page (status bar, slim bar,
//    pinned composer riding the iframe) scrolled off — "ONLY the middle should
//    scroll" (operator 2026-07-21, second report). Root is overflow-hidden now
//    and the shell tracks the DYNAMIC viewport (100dvh).

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

test.describe("chrome reveal placement (decisions/00084, 00107)", () => {
  test("the nav row reveals between the status bar and the pinned slim bar, and the topbar banner is gone", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoEditAndWaitReady(page, "index");

    // decisions/00107: the "Wixy · name" banner never shows at phone widths.
    const topbarDisplay = await page.evaluate(
      () => getComputedStyle(document.querySelector(".wx-topbar") as Element).display,
    );
    expect(topbarDisplay, "topbar banner must be gone at phone widths").toBe("none");

    await page.locator(".wx-chrome-reveal").click();
    await page.waitForTimeout(700); // let the reveal settle

    const rects = await page.evaluate(() => {
      const r = (sel: string) => {
        const el = document.querySelector(sel);
        if (el === null) return null;
        const b = el.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, height: b.height };
      };
      const overflow = document.querySelector(".wx-topbar-overflow");
      const overflowBox = overflow?.getBoundingClientRect() ?? null;
      return {
        statusbar: r(".wx-statusbar"),
        navRow: r(".wx-navrow"),
        nav: r(".wx-nav"),
        host: r(".wx-edit-bar-host"),
        navRowDisplay: getComputedStyle(document.querySelector(".wx-navrow") as Element).display,
        overflowVisible: overflowBox !== null && overflowBox.height > 0 && overflowBox.width > 0,
        overflowInRow: overflow?.closest(".wx-navrow") !== null,
      };
    });
    expect(rects.navRowDisplay, "the reveal must show the nav row").toBe("flex");
    expect(rects.navRow!.height, "the revealed nav row must paint, not open as an empty gap").toBeGreaterThan(0);
    expect(rects.nav!.top).toBeGreaterThanOrEqual(rects.statusbar!.bottom - 1);
    expect(rects.nav!.bottom).toBeLessThanOrEqual(rects.host!.top + 1);
    expect(rects.overflowInRow, "the ⋯ trigger lives in the nav row now").toBe(true);
    expect(rects.overflowVisible, "the ⋯ trigger must be visible in the revealed row").toBe(true);
    expect(errors).toEqual([]);
  });

  test("tapping the ⋯ trigger on a phone actually OPENS a visible popover (00107 regression)", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/admin/pages");
    const trigger = page.locator(".wx-topbar-overflow");
    await trigger.waitFor({ state: "visible" });

    // The trigger pins to the right of the tab strip — visible WITHOUT any
    // horizontal scrolling of the nav.
    const triggerBox = (await trigger.boundingBox())!;
    expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(390);

    await trigger.click();
    const popover = page.locator(".wx-topbar-secondary.wx-topbar-secondary-open");
    await popover.waitFor({ state: "visible" });
    const box = (await popover.boundingBox())!;
    // It renders BELOW the nav row, fully on screen — the old topbar-anchored
    // popover was clipped to zero visibility by the bar's overflow: hidden.
    expect(box.height, "popover must paint real height").toBeGreaterThan(100);
    expect(box.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height - 1);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    // …and every control group is in it (the menu is NOT empty).
    for (const sel of [
      ".wx-site-link",
      ".wx-zoom-controls",
      ".wx-font-scale-controls",
      ".wx-screenshot-button",
      ".wx-theme-toggle",
      ".wx-settings-toggle",
    ]) {
      await expect(popover.locator(sel), sel).toBeVisible();
    }
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
      await page.goto("/admin/pages"); // reset route state for the next width
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

test.describe("shell root no-scroll (decisions/00085)", () => {
  test("the root document cannot scroll even when the shell overflows the visible viewport", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoEditAndWaitReady(page, "index");
    // Reproduce the phone's exact condition deterministically: the shell sized
    // to the LARGE viewport (100vh) while the URL bar hides a strip of it — the
    // shell is 120px taller than the visible area. On the unfixed shell this is
    // precisely what makes the root document scroll the chrome off screen.
    await page.addStyleTag({ content: ".wx-shell { height: calc(100vh + 120px) !important; }" });
    const hostTopBefore = await page.evaluate(() =>
      document.querySelector(".wx-edit-bar-host")!.getBoundingClientRect().top,
    );
    // Attack 1 — a real GESTURE over the shell chrome (the operator's touch/
    // wheel on the phone), over the status bar so it can't land in the preview
    // iframe's own (legitimate) scroll.
    await page.mouse.move(195, 20);
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(200);
    const afterGesture = await page.evaluate(() => ({
      scrollY: window.scrollY,
      hostTop: document.querySelector(".wx-edit-bar-host")!.getBoundingClientRect().top,
    }));
    expect(afterGesture.scrollY, "gesture over the chrome must not scroll the root").toBe(0);
    expect(Math.abs(afterGesture.hostTop - hostTopBefore), "the chrome must not move under a gesture").toBe(0);
    // Attack 2 — even PROGRAMMATIC scrolls must fail: overflow:hidden alone
    // leaves the element a scroll container (scrollTop assignment still works);
    // overflow:clip seals it entirely. This is what "rock solid" means.
    const res = await page.evaluate(() => {
      window.scrollTo(0, 120);
      document.documentElement.scrollTop = 120;
      document.body.scrollTop = 120;
      return {
        scrollY: window.scrollY,
        rootScrollTop: document.documentElement.scrollTop,
        bodyScrollTop: document.body.scrollTop,
        hostTop: document.querySelector(".wx-edit-bar-host")!.getBoundingClientRect().top,
        htmlOverflowY: getComputedStyle(document.documentElement).overflowY,
        bodyOverflowY: getComputedStyle(document.body).overflowY,
        htmlOverscrollY: getComputedStyle(document.documentElement).overscrollBehaviorY,
      };
    });
    expect(res.htmlOverflowY, "root element must be non-scrollable").toMatch(/^(hidden|clip)$/);
    expect(res.bodyOverflowY, "body must be non-scrollable").toMatch(/^(hidden|clip)$/);
    expect(res.htmlOverscrollY, "pull-to-refresh / scroll chaining off at the root").toBe("none");
    expect(res.scrollY, "the root document must never scroll").toBe(0);
    expect(res.rootScrollTop).toBe(0);
    expect(res.bodyScrollTop, "body must not be a scroll container at all").toBe(0);
    expect(Math.abs(res.hostTop - hostTopBefore), "the pinned chrome must not move when a scroll is attempted").toBe(0);
    expect(errors).toEqual([]);
  });

  test("the served bundle sizes the shell and drawer to the DYNAMIC viewport (100dvh)", async ({ page }) => {
    await page.goto("/admin");
    const css = await page.evaluate(async () => {
      const href = (document.querySelector('link[rel="stylesheet"]') as HTMLLinkElement).href;
      return await (await fetch(href)).text();
    });
    // The committed (minified) bundle the fixture serves is the same artifact
    // prod serves — assert the vh→dvh fallback pair is actually in it.
    expect(css).toMatch(/\.wx-shell\{[^}]*?height:100vh;height:100dvh/);
    expect(css).toMatch(/\.wx-drawer\{[^}]*?height:100vh;height:100dvh/);
    // …and that toasts ride ABOVE the URL-bar strip (same root cause: fixed
    // bottom anchors to the layout viewport).
    expect(css).toMatch(/\.wx-toast-region\{[^}]*?bottom:20px;bottom:calc\(20px \+ 100vh - 100dvh\)/);
  });

  test("the middle still scrolls — the preview iframe scrolls while the root stays put", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoEditAndWaitReady(page, "index");
    const res = await page.evaluate(() => {
      const f = document.querySelector(".wx-preview-iframe") as HTMLIFrameElement;
      f.contentWindow!.scrollTo(0, 600);
      window.scrollTo(0, 600);
      return { frameY: f.contentWindow!.scrollY, rootY: window.scrollY };
    });
    expect(res.frameY, "the website in the middle MUST scroll").toBeGreaterThan(0);
    expect(res.rootY, "…while the shell chrome never moves").toBe(0);
  });
});
