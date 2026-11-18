// E2E for the Canvas tab (decisions/00206): a canvas is drawn on in the chat's one second tab, full
// screen, not inline. Starting one opens the tab on the starter's screen and offers it (a dot) on the
// other's; the inline canvas stays in the chat as the record, drawing and all, with an Open button that
// brings any canvas — an older one too — back into the tab; opening a canvas replaces whatever game held
// the tab (still only Chat plus one); and a drawing made in the tab sits on the same spot of the canvas
// everywhere it is shown: the inline canvas and the tab, on both screens, at different widths.
//
// Everything positional is measured in a real browser (bounding boxes, `elementFromPoint`).

import { expect, test } from "../fixtures";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { trackConsoleErrors } from "./helpers";

test.describe.configure({ timeout: 120_000 });

/** Mirrors `MULTI_TAP_INTERVAL_MS` in admin-ui/src/server/constants.ts. */
const MULTI_TAP_INTERVAL_MS = 400;

async function unlockServer(page: Page, name: string): Promise<void> {
  const configResponse = await page.request.post("/test/server/config");
  const { pin } = (await configResponse.json()) as { pin: string };

  await page.goto("/admin/server");
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  await page.locator(".wx-srv-panel").click();
  await expect(page.locator(".wx-srv-affordance")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
  await page.locator(".wx-srv-affordance").click();
  await expect(page.locator(".wx-srv-pinpad")).toBeVisible();
  for (const digit of pin) {
    await page.locator(`.wx-srv-pinpad-key-digit:text-is("${digit}")`).click();
  }
  await page.locator(".wx-srv-pinpad-key-submit").click();

  await expect(page.locator(".wx-srv-name-prompt:visible, .wx-srv-thread:visible")).toBeVisible({ timeout: 5000 });
  if (await page.locator(".wx-srv-name-prompt").isVisible()) {
    await page.locator(".wx-srv-name-prompt-input").fill(name);
    await page.locator(".wx-srv-name-prompt-button").click();
  }
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await expect(page.locator(".wx-srv-name-prompt")).toBeHidden();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

async function seed(page: Page, label: string, count = 3): Promise<void> {
  const response = await page.request.post("/test/server/seed-messages", {
    data: { count, spreadS: 1, startAgoS: 60, label, sender: "Fixture" },
  });
  expect(response.ok()).toBe(true);
}

/** R3: two taps within 400 ms can lock; tests act at a human cadence between separate controls. */
async function humanPause(page: Page): Promise<void> {
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

/** A light touch so R7's 10s idle lock never fires on a page a test is only watching. */
async function keepAlive(page: Page): Promise<void> {
  await page.mouse.move(3 + Math.random() * 4, 3 + Math.random() * 4);
}

async function eventually(pages: readonly Page[], check: () => Promise<boolean>, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    for (const page of pages) await keepAlive(page);
    await pages[0]!.waitForTimeout(150);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

async function closeAll(...contexts: BrowserContext[]): Promise<void> {
  for (const context of contexts) await context.close();
}

/** Starts a canvas from the ... menu; returns its seq. */
async function startCanvas(page: Page): Promise<string> {
  const before = await page.locator(".wx-srv-bubble-canvas").count();
  await page.locator(".wx-srv-more-button").click();
  await humanPause(page);
  await page.locator(".wx-srv-more-canvas").click();
  await expect(page.locator(".wx-srv-bubble-canvas")).toHaveCount(before + 1);
  const seq = await page.locator(".wx-srv-bubble-canvas").last().getAttribute("data-message-seq");
  expect(seq).not.toBeNull();
  return seq!;
}

function pane(page: Page): Locator {
  return page.locator(".wx-srv-canvas-pane");
}

function paneSurface(page: Page): Locator {
  return page.locator(".wx-srv-canvas-pane .wx-srv-canvas-surface");
}

function inlineCanvas(page: Page, seq: string): Locator {
  return page.locator(`.wx-srv-bubble-canvas[data-message-seq="${seq}"]`);
}

/** The stored drawings on canvas `seq`, in the tab (`where: "pane"`) or inline in the chat. */
function inkOn(page: Page, seq: string, where: "pane" | "chat"): Locator {
  const scope = where === "pane" ? ".wx-srv-canvas-pane" : ".wx-srv-thread";
  return page.locator(`${scope} svg.wx-srv-drawing:not(.wx-srv-drawing-live)[data-anchor-seq="${seq}"]`);
}

/** A drawing's box as fractions of the canvas surface it is on: the same on every screen. */
async function shareOf(ink: Locator, surface: Locator): Promise<{ x: number; y: number; w: number; h: number }> {
  const i = (await ink.boundingBox())!;
  const s = (await surface.boundingBox())!;
  return { x: (i.x - s.x) / s.width, y: (i.y - s.y) / s.width, w: i.width / s.width, h: i.height / s.width };
}

function expectSameShare(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, what: string): void {
  expect(Math.abs(a.x - b.x), `${what}: left`).toBeLessThan(0.015);
  expect(Math.abs(a.y - b.y), `${what}: top`).toBeLessThan(0.015);
  expect(Math.abs(a.w - b.w), `${what}: width`).toBeLessThan(0.015);
  expect(Math.abs(a.h - b.h), `${what}: height`).toBeLessThan(0.015);
}

/** A mouse stroke across the tab's canvas from (fx0, fy0) to (fx1, fy1), fractions of its box. */
async function strokeOnPane(page: Page, fx0: number, fy0: number, fx1: number, fy1: number): Promise<void> {
  const s = (await paneSurface(page).boundingBox())!;
  const at = (fx: number, fy: number) => ({ x: s.x + s.width * fx, y: s.y + s.height * fy });
  const start = at(fx0, fy0);
  const end = at(fx1, fy1);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) {
    await page.mouse.move(start.x + ((end.x - start.x) * i) / 14, start.y + ((end.y - start.y) * i) / 14 + Math.sin(i / 2) * 6);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

/** The box is wholly inside the viewport, and a tap at its centre lands on it. */
async function expectOnScreen(page: Page, locator: Locator, what: string): Promise<void> {
  await expect(locator, what).toBeVisible();
  const box = (await locator.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x, `${what} left`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${what} top`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${what} right`).toBeLessThanOrEqual(view.width + 0.5);
  expect(box.y + box.height, `${what} bottom`).toBeLessThanOrEqual(view.height + 0.5);
}

test.describe("server-canvas.spec.ts", () => {
  test("a new canvas opens full screen in the Canvas tab; the other person gets the tab; the drawing sits on the same spot of the canvas in the tab and inline, on both screens", async ({ browser }) => {
    const contextA = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    const contextB = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errorsA = trackConsoleErrors(pageA);
    const errorsB = trackConsoleErrors(pageB);
    await seed(pageA, `canvas-tab-${Date.now()}`, 6);
    await unlockServer(pageA, "Josh");
    await unlockServer(pageB, "Purdy");

    const seq = await startCanvas(pageA);

    // A: the Canvas tab is open and showing, full screen (no chat header or composer), the pen on.
    await expect(pageA.locator(".wx-srv-tab-canvas")).toBeVisible();
    await expect(pageA.locator(".wx-srv-tab-canvas")).toHaveAttribute("aria-selected", "true");
    await expect(pane(pageA)).toBeVisible();
    await expect(pageA.locator(".wx-srv-thread")).toBeHidden();
    await expect(pageA.locator(".wx-chat-composer")).toBeHidden();
    await expect(pane(pageA).locator(".wx-srv-pen-toolbar")).toBeVisible();
    await expect(pane(pageA).locator(".wx-srv-canvas-title")).toHaveText("Your canvas");
    await expectOnScreen(pageA, paneSurface(pageA), "A's canvas");
    // Still only Chat plus one tab.
    await expect(pageA.locator(".wx-srv-tab:visible")).toHaveCount(2);

    // B: the tab is offered with a dot; B stays in the chat, where the canvas is with its Open button.
    await eventually([pageA, pageB], async () => await pageB.locator(".wx-srv-tab-canvas").isVisible(), "B's Canvas tab");
    await expect(pageB.locator(".wx-srv-tab-canvas .wx-srv-tab-dot")).toBeVisible();
    await expect(pageB.locator(".wx-srv-thread")).toBeVisible();
    await expect(inlineCanvas(pageB, seq).locator(".wx-srv-canvas-open")).toBeVisible();

    // A draws in the tab.
    await strokeOnPane(pageA, 0.2, 0.3, 0.7, 0.55);
    await expect(inkOn(pageA, seq, "pane")).toHaveCount(1);
    const inTabA = await shareOf(inkOn(pageA, seq, "pane"), paneSurface(pageA));
    // The ink is where the pen went: from 20% to 70% across.
    expect(inTabA.x).toBeGreaterThan(0.17);
    expect(inTabA.x).toBeLessThan(0.21);
    expect(inTabA.x + inTabA.w).toBeGreaterThan(0.69);
    expect(inTabA.x + inTabA.w).toBeLessThan(0.73);

    // B, inline in the chat (a 390 px screen against A's 1000 px): the same spot of the canvas.
    const inkInlineB = inkOn(pageB, seq, "chat");
    await eventually([pageA, pageB], async () => (await inkInlineB.count()) === 1, "B's inline copy");
    await inlineCanvas(pageB, seq).scrollIntoViewIfNeeded();
    expectSameShare(await shareOf(inkInlineB, inlineCanvas(pageB, seq).locator(".wx-srv-canvas-surface")), inTabA, "B inline vs A's tab");

    // B opens the tab: the same spot again.
    await humanPause(pageB);
    await pageB.locator(".wx-srv-tab-canvas").click();
    await expect(pane(pageB)).toBeVisible();
    await expect(pane(pageB).locator(".wx-srv-canvas-title")).toHaveText("Josh's canvas");
    await expectOnScreen(pageB, paneSurface(pageB), "B's canvas");
    await eventually([pageA, pageB], async () => (await inkOn(pageB, seq, "pane").count()) === 1, "B's tab copy");
    expectSameShare(await shareOf(inkOn(pageB, seq, "pane"), paneSurface(pageB)), inTabA, "B's tab vs A's tab");

    // B draws too, in the tab; A sees it live in A's own tab.
    await strokeOnPane(pageB, 0.3, 0.75, 0.6, 0.8);
    await eventually([pageA, pageB], async () => (await pane(pageA).locator(`svg.wx-srv-drawing[data-anchor-seq="${seq}"] path`).count()) >= 2, "B's stroke on A's tab");

    // A back to the chat (the FAB): the inline canvas carries the drawing, on the same spot.
    await humanPause(pageA);
    await pane(pageA).locator(".wx-srv-float-fab").click();
    await expect(pageA.locator(".wx-srv-thread")).toBeVisible();
    await expect(pane(pageA)).toBeHidden();
    await inlineCanvas(pageA, seq).scrollIntoViewIfNeeded();
    const inlineInkA = inkOn(pageA, seq, "chat").first();
    await eventually([pageA], async () => (await inkOn(pageA, seq, "chat").count()) >= 1, "A's inline ink");
    expectSameShare(await shareOf(inlineInkA, inlineCanvas(pageA, seq).locator(".wx-srv-canvas-surface")), inTabA, "A inline vs A's tab");

    // The Open button brings it back into the tab.
    await humanPause(pageA);
    await inlineCanvas(pageA, seq).locator(".wx-srv-canvas-open").click();
    await expect(pane(pageA)).toBeVisible();
    await expect(pageA.locator(".wx-srv-tab-canvas")).toHaveAttribute("aria-selected", "true");

    expect(errorsA).toEqual([]);
    expect(errorsB).toEqual([]);
    await closeAll(contextA, contextB);
  });

  test("Open on an older canvas carries on with it; a canvas replaces an open game: still only Chat plus one tab", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
    const page = await context.newPage();
    const errors = trackConsoleErrors(page);
    await seed(page, `canvas-older-${Date.now()}`, 3);
    await unlockServer(page, "Purdy");

    const older = await startCanvas(page);
    await strokeOnPane(page, 0.2, 0.2, 0.5, 0.3);
    await expect(inkOn(page, older, "pane")).toHaveCount(1);
    await humanPause(page);
    await pane(page).locator(".wx-srv-float-fab").click();
    await expect(page.locator(".wx-srv-thread")).toBeVisible();

    const newer = await startCanvas(page);
    expect(Number(newer)).toBeGreaterThan(Number(older));
    await expect(pane(page)).toBeVisible();
    await expect(inkOn(page, older, "pane")).toHaveCount(0);
    await humanPause(page);
    await pane(page).locator(".wx-srv-float-fab").click();

    // Scroll up to the older canvas and open it: its drawing is there, and drawing carries on with it.
    await inlineCanvas(page, older).scrollIntoViewIfNeeded();
    await humanPause(page);
    await inlineCanvas(page, older).locator(".wx-srv-canvas-open").click();
    await expect(pane(page)).toBeVisible();
    await expect(inkOn(page, older, "pane")).toHaveCount(1);
    await strokeOnPane(page, 0.3, 0.6, 0.6, 0.7);
    await expect(pane(page).locator(`svg.wx-srv-drawing:not(.wx-srv-drawing-live)[data-anchor-seq="${older}"] path`)).toHaveCount(2);
    await expect(page.locator(".wx-srv-tab:visible")).toHaveCount(2);

    // A game takes the one second tab from the canvas...
    await humanPause(page);
    await pane(page).locator(".wx-srv-float-fab").click();
    await humanPause(page);
    await page.locator(".wx-srv-more-button").click();
    await humanPause(page);
    await page.locator(".wx-srv-more-wyr").click();
    await expect(page.locator(".wx-srv-tab-wyr")).toBeVisible();
    await expect(page.locator(".wx-srv-tab-canvas")).toBeHidden();
    await expect(page.locator(".wx-srv-tab:visible")).toHaveCount(2);
    // ...and the canvas takes it back from the game.
    await humanPause(page);
    await page.locator(".wx-srv-tab-chat").click();
    await inlineCanvas(page, older).scrollIntoViewIfNeeded();
    await humanPause(page);
    await inlineCanvas(page, older).locator(".wx-srv-canvas-open").click();
    await expect(page.locator(".wx-srv-tab-canvas")).toBeVisible();
    await expect(page.locator(".wx-srv-tab-wyr")).toBeHidden();
    await expect(page.locator(".wx-srv-tab:visible")).toHaveCount(2);

    expect(errors).toEqual([]);
    await context.close();
  });

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 360, height: 780 },
  ] as const) {
    test(`${viewport.width}px phone: the whole canvas, the pen's controls and the chat button fit the screen, and a finger draws`, async ({ browser }) => {
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
      const page = await context.newPage();
      const errors = trackConsoleErrors(page);
      await seed(page, `canvas-phone-${viewport.width}-${Date.now()}`, 2);
      await unlockServer(page, "Purdy");
      const seq = await startCanvas(page);
      await expect(pane(page)).toBeVisible();
      await expectOnScreen(page, paneSurface(page), "the canvas");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      for (const control of await pane(page).locator(".wx-srv-pen-toolbar button:visible, .wx-srv-canvas-tools button:visible").all()) {
        await expectOnScreen(page, control, `control ${await control.getAttribute("class")}`);
      }
      await expectOnScreen(page, pane(page).locator(".wx-srv-float-fab"), "the chat button");
      await expectOnScreen(page, page.locator(".wx-srv-tab-chat"), "the Chat tab");

      // One finger draws on the canvas.
      const s = (await paneSurface(page).boundingBox())!;
      const cdp = await context.newCDPSession(page);
      const touch = async (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number): Promise<void> => {
        await cdp.send("Input.dispatchTouchEvent", {
          type,
          touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
        });
      };
      const x0 = s.x + s.width * 0.25;
      const y0 = s.y + s.height * 0.5;
      await touch("touchStart", x0, y0);
      for (let i = 1; i <= 12; i++) {
        await touch("touchMove", x0 + i * 12, y0 + Math.sin(i / 2) * 10);
        await page.waitForTimeout(16);
      }
      await touch("touchEnd", 0, 0);
      await expect(inkOn(page, seq, "pane")).toHaveCount(1);
      const ink = (await inkOn(page, seq, "pane").boundingBox())!;
      expect(Math.abs(ink.x - x0)).toBeLessThan(8);

      expect(errors).toEqual([]);
      await context.close();
    });
  }
});
