// Sending must not disturb the input at all (operator report, round 2, 2026-09-25, after the
// first focus fix shipped): the box was defocused, disabled and collapsed for the length of the
// send and then given its focus back, so it flickered on every message - on a phone that is the
// soft keyboard closing and reopening - and the thread could end up off the latest message.
// Restoring focus afterwards was the wrong fix; the input must never be disabled, blurred or
// resized in the first place, including when the Send button is tapped.
//
// Real layout and focus only. A requestAnimationFrame sampler records the input's focus,
// disabled/readonly state and box, the Send button, and the thread's scroll gap on EVERY frame
// from just before the send until the confirmed message is in the thread, with the server's
// response held open so the in-flight frames exist and are observable.

import { expect, test } from "../fixtures";
import type { Page } from "@playwright/test";

const VIEWPORTS = [
  { label: "desktop", width: 1280, height: 900, hasTouch: false },
  { label: "phone", width: 402, height: 870, hasTouch: true },
] as const;

/** Mirrors `MULTI_TAP_INTERVAL_MS` in admin-ui/src/server/constants.ts. */
const MULTI_TAP_INTERVAL_MS = 400;
/** How long the send response is held open, so the in-flight state spans many frames. */
const HOLD_RESPONSE_MS = 500;

const COMPOSER_TEXTAREA = ".wx-srv-thread-view textarea";
const SEND_BUTTON = ".wx-srv-thread-view .wx-chat-send-button";

interface Sample {
  readonly t: number;
  readonly focused: boolean;
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly inputHeight: number;
  readonly inputTop: number;
  readonly sendDisabled: boolean;
  /** Pixels of thread content below the visible area: 0 means pinned to the latest message. */
  readonly threadGap: number;
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
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

/** Enough history that the thread genuinely scrolls, so "pinned to the latest" means something. */
async function seedHistory(page: Page, label: string): Promise<void> {
  const input = page.locator(COMPOSER_TEXTAREA);
  for (let i = 0; i < 14; i++) {
    const marker = `seed-${label}-${i}-${Date.now()}`;
    await input.fill(marker);
    await input.press("Enter");
    await expect(
      page.locator(".wx-srv-bubble-mine:not(.wx-srv-echo) .wx-srv-bubble-text", { hasText: marker }),
    ).toHaveCount(1);
  }
}

async function startSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const input = document.querySelector(".wx-srv-thread-view textarea") as HTMLTextAreaElement;
    const send = document.querySelector(".wx-srv-thread-view .wx-chat-send-button") as HTMLButtonElement;
    const thread = document.querySelector(".wx-srv-thread") as HTMLElement;
    const w = window as unknown as { __samples: unknown[]; __stopSampler: () => void };
    w.__samples = [];
    let running = true;
    w.__stopSampler = () => {
      running = false;
    };
    const tick = (): void => {
      if (!running) return;
      const r = input.getBoundingClientRect();
      w.__samples.push({
        t: performance.now(),
        focused: document.activeElement === input,
        disabled: input.disabled,
        readOnly: input.readOnly,
        inputHeight: r.height,
        inputTop: r.top,
        sendDisabled: send.disabled,
        threadGap: thread.scrollHeight - thread.scrollTop - thread.clientHeight,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopSampler(page: Page): Promise<Sample[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __samples: unknown[]; __stopSampler: () => void };
    w.__stopSampler();
    return w.__samples;
  }) as Promise<Sample[]>;
}

/** Holds only the POST that sends a message, so the in-flight state lasts HOLD_RESPONSE_MS. */
async function holdSendResponses(page: Page): Promise<void> {
  await page.route("**/api/admin/server/messages", async (route) => {
    if (route.request().method() === "POST") {
      await new Promise((resolve) => setTimeout(resolve, HOLD_RESPONSE_MS));
    }
    await route.continue();
  });
}

function describeSamples(samples: readonly Sample[]): string {
  const first = samples[0];
  if (first === undefined) return "no samples";
  const lost = samples.filter((s) => !s.focused).length;
  const disabled = samples.filter((s) => s.disabled).length;
  const readOnly = samples.filter((s) => s.readOnly).length;
  const sendDisabled = samples.filter((s) => s.sendDisabled).length;
  const heights = samples.map((s) => s.inputHeight);
  const tops = samples.map((s) => s.inputTop);
  const gap = Math.max(...samples.map((s) => s.threadGap));
  return (
    `${samples.length} frames over ${Math.round((samples.at(-1)?.t ?? 0) - first.t)}ms: ` +
    `unfocused ${lost}, input disabled ${disabled}, input readonly ${readOnly}, send disabled ${sendDisabled}, ` +
    `input height ${Math.min(...heights)}-${Math.max(...heights)}px, input top ${Math.min(...tops)}-${Math.max(...tops)}px, ` +
    `max thread gap ${Math.round(gap)}px`
  );
}

for (const viewport of VIEWPORTS) {
  test.describe(`sending does not disturb the input (${viewport.label})`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.hasTouch,
    });

    for (const path of ["enter", "click", "tap"] as const) {
      if (path === "tap" && !viewport.hasTouch) continue;
      test(`via ${path}: focus, enabled state, size and scroll never change`, async ({ page }) => {
        await unlockServer(page, "NoFlicker");
        await seedHistory(page, `${path}-${viewport.label}`);
        await holdSendResponses(page);

        const marker = `probe-${path}-${viewport.label}-${Date.now()}`;
        const input = page.locator(COMPOSER_TEXTAREA);
        await input.click();
        await input.fill(marker);
        await expect(input).toBeFocused();

        await startSampler(page);
        if (path === "enter") await input.press("Enter");
        else if (path === "click") await page.locator(SEND_BUTTON).click();
        else await page.locator(SEND_BUTTON).tap();

        await expect(
          page.locator(".wx-srv-bubble-mine:not(.wx-srv-echo) .wx-srv-bubble-text", { hasText: marker }),
        ).toHaveCount(1);
        await page.waitForTimeout(250);
        const samples = await stopSampler(page);
        const summary = describeSamples(samples);
        test.info().annotations.push({ type: "timeline", description: summary });
        if (process.env["WIXY_DUMP_SAMPLES"] === "1") {
          console.log(JSON.stringify(samples));
        }

        // The frames must actually span the held response, or the test proves nothing.
        expect(samples.length, summary).toBeGreaterThan(10);
        const span = (samples.at(-1)?.t ?? 0) - (samples[0]?.t ?? 0);
        expect(span, summary).toBeGreaterThan(HOLD_RESPONSE_MS);

        expect(samples.filter((s) => !s.focused).length, `focus was lost: ${summary}`).toBe(0);
        expect(samples.filter((s) => s.disabled).length, `input was disabled: ${summary}`).toBe(0);
        expect(samples.filter((s) => s.readOnly).length, `input was readonly: ${summary}`).toBe(0);

        // Sending clears the box AT ONCE (takeDraft, synchronous), which can legitimately
        // shrink a wrapped-text box to the empty floor and snap the thread to the bottom in the
        // very first frame or two - that single instant reset is correct, desired behaviour (the
        // same "the box is empty the moment you hit send" every chat app has), not the bug. What
        // must never happen is a SECOND transition, or one that lands late - that is the old
        // "settle once the network response arrives" pattern the operator saw as a flicker. So:
        // find where the box and thread stop moving, require that settle point to be within the
        // first handful of frames (long before the held response resolves), and require zero
        // further movement for the rest of the window, all the way past the response.
        const settleWithinFrames = 6;
        let lastChangeIndex = 0;
        for (let i = 1; i < samples.length; i++) {
          const prev = samples[i - 1];
          const cur = samples[i];
          if (prev === undefined || cur === undefined) continue;
          if (
            Math.abs(cur.inputHeight - prev.inputHeight) > 1 ||
            Math.abs(cur.inputTop - prev.inputTop) > 1 ||
            Math.abs(cur.threadGap - prev.threadGap) > 2
          ) {
            lastChangeIndex = i;
          }
        }
        expect(
          lastChangeIndex,
          `the input/thread kept moving instead of settling once at submit: ${summary}`,
        ).toBeLessThanOrEqual(settleWithinFrames);

        const settled = samples.slice(lastChangeIndex);
        const settledFirst = settled[0];
        for (const s of settled) {
          expect(Math.abs(s.inputHeight - (settledFirst?.inputHeight ?? 0)), `input resized after settling: ${summary}`).toBeLessThanOrEqual(1);
          expect(Math.abs(s.inputTop - (settledFirst?.inputTop ?? 0)), `input moved after settling: ${summary}`).toBeLessThanOrEqual(1);
          expect(s.threadGap, `thread drifted off the latest message after settling: ${summary}`).toBeLessThanOrEqual(2);
        }
      });
    }
  });
}
