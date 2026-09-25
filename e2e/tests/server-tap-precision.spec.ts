// R3 v1.7 (Architect ruling, operator report round 2, 2026-09-25): a double-tap only locks when
// two REAL taps land in the same place, on the same thing, quickly. Real touch input only —
// jsdom never lays anything out and can't distinguish a scroll's touch points from a tap
// (`admin-ui/tests/server/gestures.test.ts` covers the detector logic itself against synthetic
// events; this file proves it end to end on a real mobile browser).

import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/** Mirrors `MULTI_TAP_INTERVAL_MS` in admin-ui/src/server/constants.ts. */
const MULTI_TAP_INTERVAL_MS = 400;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A locator's `.evaluate()` re-resolves fresh each call, so it never reads a detached/stale
 * element — but it can catch a bubble mid-render: thread.ts swaps the optimistic echo for the
 * server-confirmed message, and for one frame either the new node hasn't been laid out yet or a
 * transitional element briefly matches, both reading back as a zero rect. Poll for a genuinely
 * laid-out box instead of trusting the first read (same pattern as server-layout.spec.ts's own
 * `stableBox`). */
async function stableBox(page: Page, locator: ReturnType<Page["locator"]>): Promise<Box> {
  let previous: Box | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = await locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    if (current.width > 0 && previous !== null && JSON.stringify(current) === JSON.stringify(previous)) {
      return current;
    }
    previous = current;
    await page.waitForTimeout(100);
  }
  throw new Error("stableBox: locator never resolved to a laid-out element");
}

async function unlockServer(page: Page, name: string): Promise<void> {
  const configResponse = await page.request.post("/test/server/config");
  const { pin } = (await configResponse.json()) as { pin: string };

  await page.goto("/admin/server");
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  await page.locator(".wx-srv-panel").click();
  await expect(page.locator(".wx-srv-affordance")).toBeVisible();
  // R2 v1.3's 400ms reveal-affordance debounce (server-chat.spec.ts, same wait).
  await page.waitForTimeout(500);
  await page.locator(".wx-srv-affordance").click();
  await expect(page.locator(".wx-srv-pinpad")).toBeVisible();
  for (const digit of pin) {
    await page.locator(`.wx-srv-pinpad-key-digit:text-is("${digit}")`).click();
  }
  await page.locator(".wx-srv-pinpad-key-submit").click();

  await expect(page.locator(".wx-srv-name-prompt:visible, .wx-srv-thread:visible")).toBeVisible({
    timeout: 5000,
  });
  if (await page.locator(".wx-srv-name-prompt").isVisible()) {
    await page.locator(".wx-srv-name-prompt-input").fill(name);
    await page.locator(".wx-srv-name-prompt-button").click();
  }
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await expect(page.locator(".wx-srv-name-prompt")).toBeHidden();
  // R3: two taps inside the chat view less than MULTI_TAP_INTERVAL_MS apart lock the panel
  // instantly (server-chat.spec.ts's own unlockServer carries the identical wait, same reason:
  // automation taps land far closer together than any person's).
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

/** Dispatches one synthetic touch-type pointer sequence directly on `el`, moving well past
 * `TAP_SLOP_PX` between down and up — what a real finger scrolling the thread produces at the
 * JS event level (a `pointercancel` is what Chrome actually fires once it decides a touch is a
 * scroll and takes it over; either way it is never a recognized tap). Real `page.touchscreen`
 * has no drag/swipe primitive, so this exercises the exact production listener
 * (`attachMultiTapListener`, wired to the real `document` in this real page) the way a flick
 * does, without needing OS-level touch injection. */
async function dispatchScrollLikeTouch(
  page: Page,
  selector: string,
  start: { x: number; y: number },
  end: { x: number; y: number },
  cancelled: boolean,
): Promise<void> {
  await page.evaluate(
    ({ selector, start, end, cancelled }) => {
      const el = document.querySelector(selector);
      if (el === null) throw new Error(`no element for ${selector}`);
      const pointerId = Math.floor(Math.random() * 1_000_000);
      const base = { bubbles: true, cancelable: true, pointerType: "touch", pointerId, isPrimary: true };
      el.dispatchEvent(new PointerEvent("pointerdown", { ...base, clientX: start.x, clientY: start.y }));
      el.dispatchEvent(new PointerEvent("pointermove", { ...base, clientX: end.x, clientY: end.y }));
      if (cancelled) {
        el.dispatchEvent(new PointerEvent("pointercancel", { ...base }));
      } else {
        el.dispatchEvent(new PointerEvent("pointerup", { ...base, clientX: end.x, clientY: end.y }));
      }
    },
    { selector, start, end, cancelled },
  );
}

test("a rapid two-finger-flick scroll of the thread never locks", async ({ page }) => {
  await unlockServer(page, "Scroll");
  // Enough history that the thread genuinely scrolls.
  for (let i = 0; i < 10; i++) {
    const input = page.locator(".wx-srv-thread-view textarea");
    await input.fill(`scroll-history-${i}-${Date.now()}`);
    await input.press("Enter");
    await page.waitForTimeout(20);
  }
  await expect(page.locator(".wx-srv-thread")).toBeVisible();

  // Two rapid, in-the-same-area flicks — both moving well past the slop (a scroll, not a tap)
  // and both landing close together in time and space, exactly the shape the operator reported
  // (rapid scrolling registering as a lock). One flick ends in a `pointercancel` (what the
  // browser actually fires once it takes the touch over for scrolling), the other in an
  // ordinary `pointerup` that still moved too far to be a tap.
  await dispatchScrollLikeTouch(page, ".wx-srv-thread", { x: 195, y: 500 }, { x: 195, y: 200 }, true);
  await dispatchScrollLikeTouch(page, ".wx-srv-thread", { x: 195, y: 480 }, { x: 195, y: 180 }, false);

  await page.waitForTimeout(200);
  // A lock detaches the thread entirely (chatMountEl.hidden = true tears it down, per
  // panel.ts) rather than merely hiding it, and the decoy sits underneath the chat overlay at
  // all times regardless of lock state — so the thread's own presence, not the decoy's
  // visibility, is what proves the panel stayed unlocked (matches server-chat.spec.ts's own
  // "returns to the decoy" assertion, `.wx-srv-thread` `toHaveCount(0)`, used in reverse here).
  await expect(page.locator(".wx-srv-thread")).toHaveCount(1);
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
});

test("a genuine same-spot double-tap on a message bubble still locks", async ({ page }) => {
  await unlockServer(page, "DoubleTap");
  const marker = `bubble-doubletap-${Date.now()}`;
  const input = page.locator(".wx-srv-thread-view textarea");
  await input.fill(marker);
  await input.press("Enter");
  const bubble = page.locator(".wx-srv-bubble-mine:not(.wx-srv-echo) .wx-srv-bubble-text", { hasText: marker });
  await expect(bubble).toBeVisible();
  const box = await stableBox(page, bubble);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  // Real touch taps, via Playwright's own touchscreen — two, in the same spot, quickly.
  await page.touchscreen.tap(x, y);
  await page.touchscreen.tap(x, y);

  await expect(page.locator(".wx-srv-thread")).toHaveCount(0);
});
