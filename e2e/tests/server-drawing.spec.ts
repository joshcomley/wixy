// E2E for live drawing, the Server chat's pen (spec/server-chat/07-live-drawing.md §7): two
// people, one draws and the other sees the stroke appear WHILE it is being drawn, then as
// stored; it stays on its message through a layout change, a scroll and a reload; Select mode
// deletes it for both; deleting the anchor message takes it along; a two-finger pan scrolls
// without drawing; rapid dots never trip the double-tap lock while Escape still locks at once;
// and the toolbar is really visible and hit-testable at desktop, 390 px and 360 px.
//
// jsdom never lays anything out, so everything positional is proven here in a real browser —
// bounding boxes and `elementFromPoint`, never mere presence (spec 06 §3.1's real-click lesson).
//
// One fixture server per worker and no reset between tests: every message a test seeds carries a
// label unique to that test, and assertions are scoped to that test's own bubbles.

import { expect, test } from "../fixtures";
import type { BrowserContext, CDPSession, Locator, Page } from "@playwright/test";
import { trackConsoleErrors } from "./helpers";

test.describe.configure({ timeout: 120_000 });

/** Mirrors `MULTI_TAP_INTERVAL_MS` in admin-ui/src/server/constants.ts. */
const MULTI_TAP_INTERVAL_MS = 400;

const PHONES = [
  { width: 390, height: 844 },
  { width: 360, height: 780 },
] as const;

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
  // Two taps less than 400ms apart lock the chat (R3): let that window pass.
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

async function seed(page: Page, label: string, count = 3): Promise<void> {
  const response = await page.request.post("/test/server/seed-messages", {
    data: { count, spreadS: 1, startAgoS: 60, label, sender: "Fixture" },
  });
  expect(response.ok()).toBe(true);
}

function bubbleWith(page: Page, text: string): Locator {
  // Exact label + number: "#1" must not also match "#10".
  return page.locator(".wx-srv-bubble").filter({ has: page.locator(".wx-srv-bubble-text", { hasText: new RegExp(`${escapeRegExp(text)}$`) }) });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The seq of a message bubble. */
async function seqOf(bubble: Locator): Promise<string> {
  const seq = await bubble.getAttribute("data-message-seq");
  expect(seq).not.toBeNull();
  return seq!;
}

/** Stored drawings anchored to `bubble`'s message (this spec's chat is shared by its tests, so
 * never count every drawing on screen). */
async function storedOn(page: Page, bubble: Locator): Promise<Locator> {
  return page.locator(`svg.wx-srv-drawing:not(.wx-srv-drawing-live)[data-anchor-seq="${await seqOf(bubble)}"]`);
}

async function liveOn(page: Page, bubble: Locator): Promise<Locator> {
  return page.locator(`svg.wx-srv-drawing-live[data-anchor-seq="${await seqOf(bubble)}"]`);
}

/** R3: two taps within 400 ms can lock (a gesture-boundary control may close a run begun on any
 * other); tests act at a human cadence between separate controls. */
async function humanPause(page: Page): Promise<void> {
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

/** A light touch so R7's 10s idle lock never fires on a page a test is only watching. */
async function keepAlive(page: Page): Promise<void> {
  await page.mouse.move(3 + Math.random() * 4, 3 + Math.random() * 4);
}

/** Polls `check` while keeping `pages` from idle-locking. */
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

async function turnPenOn(page: Page): Promise<void> {
  await page.locator(".wx-srv-pen-button").click();
  await expect(page.locator(".wx-srv-pen-toolbar")).toBeVisible();
  await expect(page.locator(".wx-srv-draw-surface")).toBeVisible();
}

/** A wavy mouse stroke across `bubble`, starting 12 px in from its left edge. Leaves the button
 * down when `release` is false. */
async function mouseStroke(page: Page, bubble: Locator, release = true): Promise<{ x: number; y: number }> {
  const box = (await bubble.boundingBox())!;
  const start = { x: box.x + 12, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(start.x + i * 8, start.y + Math.sin(i / 2) * 10);
    await page.waitForTimeout(16);
  }
  if (release) await page.mouse.up();
  return start;
}

/** Where a stored drawing's svg sits relative to its anchor bubble, in px. */
async function offsetFromAnchor(svg: Locator, bubble: Locator): Promise<{ dx: number; dy: number; width: number }> {
  const s = (await svg.boundingBox())!;
  const b = (await bubble.boundingBox())!;
  return { dx: s.x - b.x, dy: s.y - b.y, width: s.width };
}

/** spec 06 §3.1's real-click check: a genuine box inside the viewport, and `elementFromPoint`
 * at its centre really is the control (an invisible overlay would pass `toBeVisible()`). */
async function assertRealClickTarget(page: Page, locator: Locator, viewportWidth: number, viewportHeight: number, minHeight = 44): Promise<void> {
  await expect(locator).toBeVisible();
  const name = await locator.evaluate((el) => `${el.className} "${el.getAttribute("aria-label") ?? el.textContent ?? ""}"`);
  const box = (await locator.boundingBox())!;
  expect(box.width, `${name} width`).toBeGreaterThan(0);
  expect(box.height, `${name} height`).toBeGreaterThanOrEqual(minHeight - 0.5);
  expect(box.x, `${name} left`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${name} top`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${name} right`).toBeLessThanOrEqual(viewportWidth + 0.5);
  expect(box.y + box.height, `${name} bottom`).toBeLessThanOrEqual(viewportHeight + 0.5);
  const hits = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && (hit === el || el.contains(hit));
  });
  expect(hits, `${name} is what a tap at its centre hits`).toBe(true);
  // A control squeezed until its label clips still passes the checks above.
  const fit = await locator.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(fit.scroll, `${name} label fits (${fit.scroll} <= ${fit.client})`).toBeLessThanOrEqual(fit.client + 1);
}

/** Draws the Server chat in a font much WIDER than Segoe UI, as some devices do: Verdana (one of
 * the widest common UI fonts, on Windows and macOS) or else DejaVu Sans (Ubuntu's `system-ui`, the
 * font CI's runner draws the chat with). The pen toolbar's first layout fitted two lines in Segoe
 * UI but needed three in both of these, on both phones — caught only by CI (decisions/00176 #13). */
async function useWideFont(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '.wx-srv-panel, .wx-srv-panel * { font-family: Verdana, "DejaVu Sans", sans-serif !important; }',
  });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** The phone toolbar's layout contract (decisions/00176 #13), for the mode on screen now: exactly
 * two lines, nothing wider than the screen, every control a real, unclipped 44px target — and the
 * Draw | Select switch exactly where it was in the other modes (`switchAt`, from the first call),
 * so a mode change never moves it from under the finger. Returns where the switch is. */
async function assertPhoneToolbar(
  page: Page,
  viewport: { readonly width: number; readonly height: number },
  switchAt?: { readonly x: number; readonly y: number },
): Promise<{ x: number; y: number }> {
  const toolbar = (await page.locator(".wx-srv-pen-toolbar").boundingBox())!;
  expect(toolbar.height, "the toolbar is two lines").toBeGreaterThan(80);
  expect(toolbar.height, "the toolbar is two lines").toBeLessThan(110);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const control of await page.locator(".wx-srv-pen-toolbar button:visible").all()) {
    await assertRealClickTarget(page, control, viewport.width, viewport.height);
  }
  const draw = (await page.locator('.wx-srv-pen-mode[data-mode="draw"]').boundingBox())!;
  if (switchAt !== undefined) {
    expect(Math.abs(draw.x - switchAt.x), "Draw | Select never moves when the mode changes").toBeLessThan(1);
    expect(Math.abs(draw.y - switchAt.y), "Draw | Select never moves when the mode changes").toBeLessThan(1);
  }
  return { x: draw.x, y: draw.y };
}

// -- Touch, through the real browser input pipeline (CDP), so pointer events are genuine ------

interface TouchPoint {
  readonly x: number;
  readonly y: number;
  readonly id: number;
}

async function touch(cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", points: readonly TouchPoint[]): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((point) => ({ x: point.x, y: point.y, id: point.id, radiusX: 4, radiusY: 4, force: 1 })),
  });
}

test.describe("server-drawing.spec.ts", () => {
  test("A draws: B sees the stroke live before A lifts, then stored, in the same place; it survives a reload", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errorsA = trackConsoleErrors(pageA);
    const errorsB = trackConsoleErrors(pageB);
    const label = `draw-live-${Date.now()}`;
    await seed(pageA, label);
    await unlockServer(pageA, "Alice");
    await unlockServer(pageB, "Bob");
    const targetA = bubbleWith(pageA, `${label} #2`);
    const targetB = bubbleWith(pageB, `${label} #2`);
    await expect(targetA).toBeVisible();
    await expect(targetB).toBeVisible();
    const storedPosts: number[] = [];
    pageA.on("response", (response) => {
      if (/\/api\/admin\/server\/drawings$/.test(response.url())) storedPosts.push(response.status());
    });

    await turnPenOn(pageA);
    await mouseStroke(pageA, targetA, false);
    // Still holding the button: B already sees it, as a live stroke, and nothing is stored yet.
    const liveB = await liveOn(pageB, targetB);
    await eventually([pageB], async () => (await liveB.locator("path").count()) === 1, "B's live stroke");
    expect(storedPosts).toEqual([]);
    const liveOffset = await offsetFromAnchor(liveB, targetB);
    await pageB.screenshot({ path: test.info().outputPath("b-live.png") });
    await pageA.mouse.up();

    // Stored: the live preview is replaced by the stored drawing on B, at the same place.
    const storedB = await storedOn(pageB, targetB);
    await eventually([pageA, pageB], async () => (await storedB.count()) === 1 && (await liveB.count()) === 0, "B's stored stroke");
    expect(storedPosts).toEqual([201]);
    const storedOffsetB = await offsetFromAnchor(storedB, targetB);
    expect(Math.abs(storedOffsetB.dy - liveOffset.dy)).toBeLessThan(3);
    expect(Math.abs(storedOffsetB.dx - liveOffset.dx)).toBeLessThan(3);
    const storedA = await storedOn(pageA, targetA);
    await expect(storedA).toHaveCount(1);
    const offsetA = await offsetFromAnchor(storedA, targetA);
    // Same size of screen, so the same place on both (s = 1).
    expect(Math.abs(offsetA.dy - storedOffsetB.dy)).toBeLessThan(2);
    expect(Math.abs(offsetA.dx - storedOffsetB.dx)).toBeLessThan(2);
    await pageB.screenshot({ path: test.info().outputPath("b-stored.png") });

    // A reload loses nothing: the drawing comes back from the server onto the same message.
    await pageA.reload();
    await unlockServer(pageA, "Alice");
    const reloadedAnchor = bubbleWith(pageA, `${label} #2`);
    const reloaded = await storedOn(pageA, reloadedAnchor);
    await eventually([pageA], async () => (await reloaded.count()) === 1, "the drawing after a reload");
    const offsetAfter = await offsetFromAnchor(reloaded, reloadedAnchor);
    expect(Math.abs(offsetAfter.dy - offsetA.dy)).toBeLessThan(2);
    expect(Math.abs(offsetAfter.dx - offsetA.dx)).toBeLessThan(2);

    expect(errorsA).toEqual([]);
    expect(errorsB).toEqual([]);
    await closeAll(contextA, contextB);
  });

  test("the drawing scrolls with its message and stays on it when the message above grows", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const label = `draw-stick-${Date.now()}`;
    await seed(pageA, label, 12);
    await unlockServer(pageA, "Alice");
    await unlockServer(pageB, "Bob");
    const anchor = bubbleWith(pageA, `${label} #11`);
    await anchor.scrollIntoViewIfNeeded();
    await turnPenOn(pageA);
    await mouseStroke(pageA, anchor);
    const svg = await storedOn(pageA, anchor);
    await expect(svg).toHaveCount(1);
    await pageA.locator(".wx-srv-pen-done").click();
    const before = await offsetFromAnchor(svg, anchor);

    // Scrolling moves the drawing with its message, exactly.
    const thread = pageA.locator(".wx-srv-thread");
    await thread.evaluate((el) => {
      el.scrollTop = Math.max(0, el.scrollTop - 120);
    });
    await pageA.waitForTimeout(100);
    const scrolled = await offsetFromAnchor(svg, anchor);
    expect(Math.abs(scrolled.dy - before.dy)).toBeLessThan(1);

    // The message ABOVE grows (B reacts to it: a reactions row appears) — the drawing follows
    // its anchor down instead of staying where it was painted.
    const above = bubbleWith(pageB, `${label} #10`);
    await above.scrollIntoViewIfNeeded();
    const anchorTopBefore = (await anchor.boundingBox())!.y;
    await above.hover();
    await above.locator(".wx-srv-message-actions-trigger").click();
    await above.getByRole("menuitemcheckbox", { name: "Thumbs up" }).click();
    const aboveOnA = bubbleWith(pageA, `${label} #10`);
    await eventually([pageA, pageB], async () => (await aboveOnA.locator(".wx-srv-reaction-chip").count()) === 1, "the reaction on A");
    await eventually([pageA], async () => ((await anchor.boundingBox())!.y) > anchorTopBefore + 5, "the anchor to move down");
    const grown = await offsetFromAnchor(svg, anchor);
    expect(Math.abs(grown.dy - before.dy)).toBeLessThan(1);
    expect(Math.abs(grown.dx - before.dx)).toBeLessThan(1);
    await closeAll(contextA, contextB);
  });

  test("B selects A's drawing in Select mode and deletes it: it vanishes for both", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const label = `draw-delete-${Date.now()}`;
    await seed(pageA, label);
    await unlockServer(pageA, "Alice");
    await unlockServer(pageB, "Bob");
    const anchorA = bubbleWith(pageA, `${label} #2`);
    const anchorB = bubbleWith(pageB, `${label} #2`);
    await turnPenOn(pageA);
    const start = await mouseStroke(pageA, anchorA);
    const boxA = (await anchorA.boundingBox())!;
    await expect(await storedOn(pageA, anchorA)).toHaveCount(1);
    const storedB = await storedOn(pageB, anchorB);
    await eventually([pageA, pageB], async () => (await storedB.count()) === 1, "B's copy");

    await turnPenOn(pageB);
    await humanPause(pageB);
    await pageB.locator('.wx-srv-pen-mode[data-mode="select"]').click();
    await expect(pageB.locator(".wx-srv-draw-surface")).toHaveCount(0);
    // Tap ON the stroke (its first point is where A started, on the same-size screen).
    const boxB = (await anchorB.boundingBox())!;
    await humanPause(pageB);
    await pageB.mouse.click(boxB.x + (start.x - boxA.x) + 2, boxB.y + (start.y - boxA.y));
    await expect(pageB.locator(".wx-srv-drawing-selection")).toBeVisible();
    const deleteButton = pageB.locator(".wx-srv-pen-delete");
    await expect(deleteButton).toBeEnabled();
    await humanPause(pageB);
    await deleteButton.click();
    await expect(pageB.locator(".wx-srv-pen-confirm-question")).toHaveText("Delete this drawing for everyone?");
    await pageB.locator(".wx-srv-pen-confirm-delete").click();

    await expect(storedB).toHaveCount(0);
    const storedA = await storedOn(pageA, anchorA);
    await eventually([pageA, pageB], async () => (await storedA.count()) === 0, "A's copy to vanish");
    // The message itself is untouched, on both.
    await expect(anchorA).toBeVisible();
    await expect(anchorB).toBeVisible();
    await closeAll(contextA, contextB);
  });

  test("deleting the anchor message takes its drawing with it, on both screens", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const label = `draw-anchor-${Date.now()}`;
    await seed(pageA, label);
    await unlockServer(pageA, "Alice");
    await unlockServer(pageB, "Bob");
    const anchorA = bubbleWith(pageA, `${label} #2`);
    const anchorB = bubbleWith(pageB, `${label} #2`);
    const seq = await seqOf(anchorA);
    await turnPenOn(pageA);
    await mouseStroke(pageA, anchorA);
    const storedB = await storedOn(pageB, anchorB);
    await eventually([pageA, pageB], async () => (await storedB.count()) === 1, "B's copy");
    await pageA.locator(".wx-srv-pen-done").click();
    await humanPause(pageA);

    await anchorA.hover();
    await anchorA.locator(".wx-srv-message-actions-trigger").click();
    await anchorA.getByRole("menuitem", { name: "Delete for everyone" }).click();
    await anchorA.locator(".wx-srv-message-delete-confirm-button").click();
    await expect(pageA.locator(`svg.wx-srv-drawing[data-anchor-seq="${seq}"]`)).toHaveCount(0);
    await eventually(
      [pageA, pageB],
      async () => (await pageB.locator(`svg.wx-srv-drawing[data-anchor-seq="${seq}"]`).count()) === 0,
      "B's copy to go",
    );
    await expect(anchorB).toHaveCount(0);
    await closeAll(contextA, contextB);
  });

  test("rapid dots in Draw mode never trip the double-tap lock; Escape mid-stroke locks at once and B's preview goes", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const label = `draw-lock-${Date.now()}`;
    await seed(pageA, label);
    await unlockServer(pageA, "Alice");
    await unlockServer(pageB, "Bob");
    const anchorA = bubbleWith(pageA, `${label} #2`);
    const anchorB = bubbleWith(pageB, `${label} #2`);
    await turnPenOn(pageA);
    const box = (await anchorA.boundingBox())!;
    await humanPause(pageA);
    // Two dots in the same spot, 100 ms apart: content (an "i"'s dot, a smiley's eyes), never a lock.
    await pageA.mouse.click(box.x + 30, box.y + 20);
    await pageA.waitForTimeout(100);
    await pageA.mouse.click(box.x + 31, box.y + 20);
    await pageA.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
    await expect(pageA.locator(".wx-srv-thread")).toBeVisible();
    await expect((await storedOn(pageA, anchorA)).locator("path")).toHaveCount(2);
    const storedB = await storedOn(pageB, anchorB);
    await eventually([pageA, pageB], async () => (await storedB.locator("path").count()) === 2, "B's two dots");

    // Mid-stroke, Escape locks at once; the withdrawn stroke's preview leaves B's screen well
    // before the 5 s "vanished drawer" timeout would have removed it. (The stroke joins the same
    // pen session's drawing, anchored to #2.)
    await mouseStroke(pageA, bubbleWith(pageA, `${label} #3`), false);
    const liveB = await liveOn(pageB, anchorB);
    await eventually([pageB], async () => (await liveB.count()) === 1, "B's live preview");
    await pageA.keyboard.press("Escape");
    await expect(pageA.locator(".wx-srv-thread")).toHaveCount(0);
    await expect(pageA.locator(".wx-srv-decoy")).toBeVisible();
    const lockedAt = Date.now();
    await eventually([pageB], async () => (await liveB.count()) === 0, "B's preview to go", 3_000);
    expect(Date.now() - lockedAt).toBeLessThan(3_000);
    await pageA.mouse.up();
    // The withdrawn stroke was never stored: B still has exactly the two dots.
    await pageB.waitForTimeout(1_000);
    await expect(storedB.locator("path")).toHaveCount(2);
    await closeAll(contextA, contextB);
  });

  test("desktop: the Pen button and toolbar are real, hit-testable 44px targets on one line", async ({ browser }) => {
    const viewport = { width: 1280, height: 800 };
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const label = `draw-desk-${Date.now()}`;
    await seed(page, label);
    await unlockServer(page, "Alice");
    await assertRealClickTarget(page, page.locator(".wx-srv-pen-button"), viewport.width, viewport.height);
    await turnPenOn(page);
    for (const control of await page.locator(".wx-srv-pen-toolbar button:visible").all()) {
      await assertRealClickTarget(page, control, viewport.width, viewport.height);
    }
    const toolbar = (await page.locator(".wx-srv-pen-toolbar").boundingBox())!;
    expect(toolbar.height).toBeLessThan(60); // one line at desktop width
    await page.screenshot({ path: test.info().outputPath("desktop-draw.png") });
    await humanPause(page);
    await page.locator('.wx-srv-pen-mode[data-mode="select"]').click();
    for (const control of await page.locator(".wx-srv-pen-toolbar button:visible").all()) {
      await assertRealClickTarget(page, control, viewport.width, viewport.height);
    }
    expect((await page.locator(".wx-srv-pen-toolbar").boundingBox())!.height).toBeLessThan(60);
    await page.screenshot({ path: test.info().outputPath("desktop-select.png") });

    // A much wider font changes nothing at desktop width: still one line, every label whole.
    await useWideFont(page);
    for (const mode of ["select", "draw"] as const) {
      await humanPause(page);
      await page.locator(`.wx-srv-pen-mode[data-mode="${mode}"]`).click();
      for (const control of await page.locator(".wx-srv-pen-toolbar button:visible").all()) {
        await assertRealClickTarget(page, control, viewport.width, viewport.height);
      }
      expect((await page.locator(".wx-srv-pen-toolbar").boundingBox())!.height).toBeLessThan(60);
    }
    await context.close();
  });

  for (const viewport of PHONES) {
    test(`${viewport.width}px phone: toolbar wraps to two lines and every control is hit-testable; one finger draws, two fingers scroll without drawing`, async ({ browser }) => {
      const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      const errors = trackConsoleErrors(page);
      const label = `draw-phone-${viewport.width}-${Date.now()}`;
      await seed(page, label, 30);
      await unlockServer(page, "Alice");
      const last = bubbleWith(page, `${label} #30`);
      await expect(last).toBeVisible();
      await assertRealClickTarget(page, page.locator(".wx-srv-pen-button"), viewport.width, viewport.height);
      await turnPenOn(page);

      // §5: on a phone it wraps onto two lines rather than overflowing — the same two lines in
      // every mode, with Draw | Select in the same place.
      const switchAt = await assertPhoneToolbar(page, viewport);

      const cdp = await context.newCDPSession(page);
      const created: number[] = [];
      page.on("response", (response) => {
        if (/\/api\/admin\/server\/drawings$/.test(response.url())) created.push(response.status());
      });

      // One finger draws, across the newest message.
      const lastBox = (await last.boundingBox())!;
      const y = lastBox.y + lastBox.height / 2;
      const x0 = lastBox.x + 16;
      await touch(cdp, "touchStart", [{ x: x0, y, id: 0 }]);
      for (let i = 1; i <= 10; i++) await touch(cdp, "touchMove", [{ x: x0 + i * 10, y: y + (i % 2) * 8, id: 0 }]);
      await touch(cdp, "touchEnd", []);
      const stored = await storedOn(page, last);
      // It shows at once (drawn locally while it is being stored), then the store answers.
      await eventually([page], async () => (await stored.count()) === 1 && created.length === 1, "the one-finger stroke, stored");
      expect(created).toEqual([201]);
      await page.screenshot({ path: test.info().outputPath(`phone-${viewport.width}-draw.png`) });

      // Select mode: tap the stroke; its controls and the confirmation are real targets too.
      await humanPause(page);
      await page.locator('.wx-srv-pen-mode[data-mode="select"]').click();
      await humanPause(page);
      await page.touchscreen.tap(x0 + 2, y);
      await expect(page.locator(".wx-srv-drawing-selection")).toBeVisible();
      await assertPhoneToolbar(page, viewport, switchAt);
      await page.screenshot({ path: test.info().outputPath(`phone-${viewport.width}-select.png`) });
      await humanPause(page);
      await page.locator(".wx-srv-pen-delete").click();
      await expect(page.locator(".wx-srv-pen-confirm-question")).toBeVisible();
      await assertPhoneToolbar(page, viewport, switchAt);
      await page.screenshot({ path: test.info().outputPath(`phone-${viewport.width}-confirm.png`) });
      await page.locator(".wx-srv-pen-confirm-cancel").click();
      await expect(stored).toHaveCount(1);

      // Back in Draw mode, two fingers (the second within 150 ms) scroll the thread by their
      // movement — the content follows them down, revealing earlier messages — and draw nothing.
      await humanPause(page);
      await page.locator('.wx-srv-pen-mode[data-mode="draw"]').click();
      const thread = page.locator(".wx-srv-thread");
      await thread.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const scrollBefore = await thread.evaluate((el) => el.scrollTop);
      const surface = (await page.locator(".wx-srv-draw-surface").boundingBox())!;
      const a = { x: surface.x + surface.width / 2 - 40, y: surface.y + 60, id: 0 };
      const b = { x: surface.x + surface.width / 2 + 40, y: surface.y + 60, id: 1 };
      await touch(cdp, "touchStart", [a]);
      await touch(cdp, "touchStart", [a, b]);
      for (let i = 1; i <= 8; i++) {
        await touch(cdp, "touchMove", [{ ...a, y: a.y + i * 20 }, { ...b, y: b.y + i * 20 }]);
      }
      await touch(cdp, "touchEnd", []);
      await page.waitForTimeout(500);
      const scrollAfter = await thread.evaluate((el) => el.scrollTop);
      expect(scrollBefore - scrollAfter).toBeGreaterThan(100);
      expect(created).toEqual([201]);
      await expect(page.locator(".wx-srv-thread")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`phone-${viewport.width}-panned.png`) });

      // The same contract in a much wider font, in every mode (decisions/00176 #13).
      await useWideFont(page);
      const wideSwitchAt = await assertPhoneToolbar(page, viewport);
      await page.screenshot({ path: test.info().outputPath(`phone-${viewport.width}-wide-draw.png`) });
      await humanPause(page);
      await page.locator('.wx-srv-pen-mode[data-mode="select"]').click();
      await humanPause(page);
      await page.locator(".wx-srv-pen-next").click();
      await expect(page.locator(".wx-srv-drawing-selection")).toBeVisible();
      await assertPhoneToolbar(page, viewport, wideSwitchAt);
      await page.screenshot({ path: test.info().outputPath(`phone-${viewport.width}-wide-select.png`) });
      await humanPause(page);
      await page.locator(".wx-srv-pen-delete").click();
      await expect(page.locator(".wx-srv-pen-confirm-question")).toBeVisible();
      await assertPhoneToolbar(page, viewport, wideSwitchAt);
      await page.screenshot({ path: test.info().outputPath(`phone-${viewport.width}-wide-confirm.png`) });
      await page.locator(".wx-srv-pen-confirm-cancel").click();
      await expect(stored).toHaveCount(1);
      expect(errors).toEqual([]);
      await context.close();
    });
  }
});
