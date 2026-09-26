import { expect, test } from "../fixtures";
import type { Browser, BrowserContext, Page } from "@playwright/test";

// spec/server-chat/05-voice-transcription.md: opt-in voice-note transcription, against the
// fixture's fake cmd (which implements cmd's private mode + capability probe). Every gesture
// pair is spaced past the 400ms multi-tap window, or the chat would (correctly) lock.

const MULTI_TAP_INTERVAL_MS = 400;
const TAP_GAP_MS = MULTI_TAP_INTERVAL_MS + 100;
const DESKTOP = { width: 1280, height: 800 } as const;
const PHONE = { width: 402, height: 870 } as const;
const TRANSCRIPT = "hello from the fake transcriber";

test.describe.configure({ timeout: 90_000 });

interface Stats {
  requests: number;
  retained: number;
  maxInFlight: number;
  lastFields: Record<string, string> | null;
  lastAudioBytes: number;
  lastAudioIsMp4: boolean;
}

async function configure(page: Page, body: Record<string, unknown>): Promise<Stats> {
  const response = await page.request.post("/test/server/transcribe-config", { data: body });
  expect(response.ok()).toBe(true);
  return (await response.json()) as Stats;
}

async function stats(page: Page): Promise<Stats> {
  return (await (await page.request.post("/test/server/transcribe-stats")).json()) as Stats;
}

// The fixture runs ONE chat for the whole suite, and other specs assert exact counts (server-media
// expects exactly one `.wx-srv-voice`), so every note this spec seeds is removed again.
const seededSeqs: number[] = [];

async function seedVoice(page: Page, sender: string, seconds = 12): Promise<number> {
  const response = await page.request.post("/test/server/seed-voice", { data: { sender, seconds } });
  expect(response.ok()).toBe(true);
  const seq = ((await response.json()) as { seq: number }).seq;
  seededSeqs.push(seq);
  return seq;
}

async function openPinPad(page: Page): Promise<void> {
  const { pin } = (await (await page.request.post("/test/server/config")).json()) as { pin: string };
  await page.locator(".wx-srv-panel").click();
  await expect(page.locator(".wx-srv-affordance")).toBeVisible();
  await page.waitForTimeout(TAP_GAP_MS);
  await page.locator(".wx-srv-affordance").click();
  await expect(page.locator(".wx-srv-pinpad")).toBeVisible();
  for (const digit of pin) {
    await page.locator(`.wx-srv-pinpad-key-digit:text-is("${digit}")`).click();
  }
  await page.locator(".wx-srv-pinpad-key-submit").click();
}

/** Unlock the chat and set the display name (first unlock on this browser context). */
async function unlock(page: Page, name: string): Promise<void> {
  await page.goto("/admin/server");
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  await openPinPad(page);
  await expect(page.locator(".wx-srv-name-prompt")).toBeVisible();
  await page.locator(".wx-srv-name-prompt-input").fill(name);
  await page.locator(".wx-srv-name-prompt-button").click();
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await page.waitForTimeout(TAP_GAP_MS);
}

/** Any pointer activity restarts the 10-second idle lock; a device that is only being watched
 * would otherwise lock while the other one works. */
async function keepAwake(page: Page): Promise<void> {
  await page.mouse.move(40 + Math.floor(Math.random() * 40), 40 + Math.floor(Math.random() * 40));
}

function note(page: Page, seq: number) {
  return page.locator(`[data-message-seq="${seq}"]`);
}

async function newDevice(
  browser: Browser,
  viewport: { width: number; height: number },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  return { context, page: await context.newPage() };
}

test.beforeEach(async ({ page }) => {
  await configure(page, { private: false, hold: false, status: 200, text: TRANSCRIPT, reset: true });
});

test.afterEach(async ({ page }) => {
  await configure(page, { private: false, hold: false, status: 200 });
  for (const seq of seededSeqs.splice(0)) {
    const response = await page.request.post("/test/server/delete-message", { data: { seq } });
    expect(response.ok()).toBe(true);
  }
});

for (const [label, viewport] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(`server-transcription.spec.ts (${label} ${viewport.width}x${viewport.height})`, () => {
    test.use({ viewport });

    test("offers no control, and sends nothing, while cmd cannot promise private mode", async ({ page }) => {
      const seq = await seedVoice(page, `Nopriv ${label}`);
      await unlock(page, "Watcher");

      await expect(note(page, seq).locator(".wx-srv-voice")).toBeVisible();
      await expect(note(page, seq).getByRole("button", { name: "Transcribe this voice note" })).toHaveCount(0);
      expect(await stats(page)).toMatchObject({ requests: 0, retained: 0 });
    });

    test("is opt-in: the note is only sent to cmd when Transcribe is clicked, in private mode", async ({ page }) => {
      await configure(page, { private: true, text: TRANSCRIPT });
      const seq = await seedVoice(page, `Optin ${label}`);
      await unlock(page, "Reader");

      const button = note(page, seq).getByRole("button", { name: "Transcribe this voice note" });
      await expect(button).toBeVisible();
      await page.waitForTimeout(1_500); // an idle voice note is never transcribed by itself
      expect((await stats(page)).requests).toBe(0);

      await button.click();
      await expect(note(page, seq).locator(".wx-srv-transcript-text")).toHaveText(TRANSCRIPT);
      await expect(note(page, seq).getByRole("button", { name: "Hide transcript" })).toBeVisible();

      const after = await stats(page);
      expect(after.requests).toBe(1);
      expect(after.lastFields).toEqual({ private: "1", cleanup: "0" });
      expect(after.lastAudioIsMp4).toBe(true);
      expect(after.lastAudioBytes).toBeGreaterThan(1_000);
      expect(after.retained).toBe(0);
    });

    test("a note that is playing keeps playing when its transcript arrives", async ({ page }) => {
      await configure(page, { private: true, hold: true, text: TRANSCRIPT });
      const seq = await seedVoice(page, `Playing ${label}`, 20);
      await unlock(page, "Listener");
      const bubble = note(page, seq);

      await bubble.getByRole("button", { name: "Transcribe this voice note" }).click();
      await expect(bubble.locator(".wx-srv-transcript-pending")).toBeVisible();
      await page.waitForTimeout(TAP_GAP_MS);

      await bubble.getByRole("button", { name: "Play voice note" }).click();
      const audio = bubble.locator("audio");
      await expect.poll(() => audio.evaluate((node) => (node as HTMLAudioElement).currentTime)).toBeGreaterThan(0.3);
      await audio.evaluate((node) => {
        (node as HTMLAudioElement).dataset["e2eMarker"] = "same-element";
      });
      const before = await audio.evaluate((node) => (node as HTMLAudioElement).currentTime);

      await configure(page, { hold: false }); // cmd answers: the transcript reaches the stream now
      await expect(bubble.locator(".wx-srv-transcript-text")).toHaveText(TRANSCRIPT);

      const state = await audio.evaluate((node) => ({
        marker: (node as HTMLAudioElement).dataset["e2eMarker"],
        paused: (node as HTMLAudioElement).paused,
        currentTime: (node as HTMLAudioElement).currentTime,
        src: (node as HTMLAudioElement).getAttribute("src"),
      }));
      expect(state.marker).toBe("same-element"); // the very same <audio>, not a rebuilt one
      expect(state.src).not.toBeNull();
      expect(state.paused).toBe(false);
      expect(state.currentTime).toBeGreaterThanOrEqual(before);
      await expect(bubble.getByRole("button", { name: "Pause voice note" })).toBeVisible();
    });

    test("a failure shows a plain error, and Retry transcribes it", async ({ page }) => {
      await configure(page, { private: true, status: 502 });
      const seq = await seedVoice(page, `Retry ${label}`);
      await unlock(page, "Retrier");
      const bubble = note(page, seq);

      await bubble.getByRole("button", { name: "Transcribe this voice note" }).click();
      await expect(bubble.locator(".wx-srv-transcript-error")).toHaveText("Couldn't transcribe this voice note.");
      await expect(bubble.locator(".wx-srv-transcript-text")).toHaveCount(0);

      await configure(page, { status: 200 });
      await page.waitForTimeout(TAP_GAP_MS);
      await bubble.getByRole("button", { name: "Retry transcribing this voice note" }).click();
      await expect(bubble.locator(".wx-srv-transcript-text")).toHaveText(TRANSCRIPT);
      expect((await stats(page)).requests).toBe(2);
    });
  });
}

test.describe("server-transcription.spec.ts (two devices)", () => {
  test("both devices see it pending then done; Hide is per device", async ({ page, browser }) => {
    await configure(page, { private: true, hold: true, text: TRANSCRIPT });
    const seq = await seedVoice(page, "Twodevices");

    const desktop = await newDevice(browser, DESKTOP);
    const phone = await newDevice(browser, PHONE);
    try {
      await unlock(desktop.page, "Ann");
      await unlock(phone.page, "Bea");
      const onDesktop = note(desktop.page, seq);
      const onPhone = note(phone.page, seq);

      await keepAwake(phone.page);
      await expect(onPhone.getByRole("button", { name: "Transcribe this voice note" })).toBeVisible();
      await onDesktop.getByRole("button", { name: "Transcribe this voice note" }).click();

      await keepAwake(desktop.page);
      await keepAwake(phone.page);
      await expect(onDesktop.locator(".wx-srv-transcript-pending")).toBeVisible();
      await expect(onPhone.locator(".wx-srv-transcript-pending")).toBeVisible(); // told by the stream
      // The spinner shows once the pending row is committed, a moment before the job's request
      // reaches cmd — so wait for it (parked at cmd by `hold`) rather than asserting instantly.
      await expect.poll(async () => (await stats(page)).requests).toBe(1);

      await configure(page, { hold: false });
      await keepAwake(desktop.page);
      await keepAwake(phone.page);
      await expect(onDesktop.locator(".wx-srv-transcript-text")).toHaveText(TRANSCRIPT);
      await expect(onPhone.locator(".wx-srv-transcript-text")).toHaveText(TRANSCRIPT);

      await keepAwake(phone.page);
      await onPhone.getByRole("button", { name: "Hide transcript" }).click();
      await expect(onPhone.locator(".wx-srv-transcript-text")).toHaveCount(0);
      await expect(onPhone.getByRole("button", { name: "Show transcript" })).toBeVisible();
      await expect(onDesktop.locator(".wx-srv-transcript-text")).toHaveText(TRANSCRIPT); // other device unaffected
      expect((await stats(page)).requests).toBe(1); // reading it again never asks cmd
    } finally {
      await desktop.context.close();
      await phone.context.close();
    }
  });
});

test.describe("server-transcription.spec.ts (phone layout, 402px)", () => {
  test.use({ viewport: PHONE });

  test("long transcripts wrap inside the bubble, never widen the page, and buttons are tappable", async ({ page }) => {
    const longWord = "x".repeat(90);
    const text = `${"This is a long transcript that should wrap onto several lines on a phone. ".repeat(6)}${longWord}`;
    await configure(page, { private: true, text });
    const seq = await seedVoice(page, "Layout");
    await unlock(page, "Layouter");
    const bubble = note(page, seq);

    const transcribe = bubble.getByRole("button", { name: "Transcribe this voice note" });
    const tapBox = await transcribe.boundingBox();
    expect(tapBox?.height ?? 0).toBeGreaterThanOrEqual(43.5); // a phone tap target
    await transcribe.click();
    await expect(bubble.locator(".wx-srv-transcript-text")).toBeVisible();
    await bubble.locator(".wx-srv-transcript-text").scrollIntoViewIfNeeded();

    const geometry = await page.evaluate((selector) => {
      const bubbleEl = document.querySelector<HTMLElement>(selector)!;
      const textEl = bubbleEl.querySelector<HTMLElement>(".wx-srv-transcript-text")!;
      const bubbleRect = bubbleEl.getBoundingClientRect();
      const textRect = textEl.getBoundingClientRect();
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bubbleRight: bubbleRect.right,
        textRight: textRect.right,
        viewport: document.documentElement.clientWidth,
        lines: Math.round(textRect.height / parseFloat(getComputedStyle(textEl).lineHeight)),
      };
    }, `[data-message-seq="${seq}"]`);
    expect(geometry.pageOverflow).toBeLessThanOrEqual(0);
    expect(geometry.textRight).toBeLessThanOrEqual(geometry.bubbleRight + 1);
    expect(geometry.bubbleRight).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.lines).toBeGreaterThan(3); // it wrapped

    const hide = bubble.getByRole("button", { name: "Hide transcript" });
    expect((await hide.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43.5);
  });
});
