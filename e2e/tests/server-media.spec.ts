import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const MULTI_TAP_INTERVAL_MS = 400;
const PHOTO = fileURLToPath(new URL("../fixtures/livechat-photo-gps.jpg", import.meta.url));
const VIDEO = fileURLToPath(new URL("../fixtures/livechat-video.mp4", import.meta.url));
const ROTATED_VIDEO = fileURLToPath(new URL("../fixtures/livechat-rotated.mov", import.meta.url));

test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});
test.describe.configure({ timeout: 60_000 });

async function openPinPad(page: Page): Promise<string> {
  const configResponse = await page.request.post("/test/server/config");
  const { pin } = (await configResponse.json()) as { pin: string };
  await page.locator(".wx-srv-panel").click();
  await expect(page.locator(".wx-srv-affordance")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
  await page.locator(".wx-srv-affordance").click();
  await expect(page.locator(".wx-srv-pinpad")).toBeVisible();
  for (const digit of pin) {
    await page.locator(`.wx-srv-pinpad-key-digit:text-is("${digit}")`).click();
  }
  await page.locator(".wx-srv-pinpad-key-submit").click();
  return pin;
}

async function unlockServer(page: Page, name: string): Promise<void> {
  await page.goto("/admin/server");
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  await openPinPad(page);
  await expect(page.locator(".wx-srv-name-prompt")).toBeVisible();
  await page.locator(".wx-srv-name-prompt-input").fill(name);
  await page.locator(".wx-srv-name-prompt-button").click();
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

async function unlockAgain(page: Page): Promise<void> {
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  await openPinPad(page);
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

async function waitForUploads(page: Page, expectedCount: number): Promise<void> {
  const chips = page.locator(".wx-chat-attachment-chip");
  const send = page.locator(".wx-chat-send-button");
  const error = page.locator(".wx-chat-composer-error");
  await expect(chips).toHaveCount(expectedCount);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await error.isVisible()) throw new Error(`media upload failed: ${await error.textContent()}`);
    if (await send.isEnabled()) break;
    await page.mouse.move(24 + attempt, 24 + attempt);
    await page.waitForTimeout(250);
  }
  await expect(chips).toHaveCount(expectedCount);
  await expect(error).toBeHidden();
  await expect(send).toBeEnabled();
}

async function waitForRenderedAttachments(
  page: Page,
  selector: string,
  expectedCount: number,
  timeout = 5_000,
): Promise<void> {
  const attachments = page.locator(selector);
  // The fixture's real FFmpeg queue runs asynchronously and can take longer
  // when the media specs follow the full chat/lock matrix on a busy host.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await attachments.count() === expectedCount) return;
    await page.mouse.move(24 + attempt, 24 + attempt);
    await page.waitForTimeout(250);
  }
  await expect(attachments).toHaveCount(expectedCount, { timeout });
}

test.describe("server-media.spec.ts (P6b)", () => {
  test("photo upload shows chunk progress, survives panic/unlock, and opens the lightbox", async ({ page }) => {
    let releaseChunk!: () => void;
    let announceSecondChunk!: () => void;
    const secondChunkStarted = new Promise<void>((resolve) => { announceSecondChunk = resolve; });
    const secondChunkGate = new Promise<void>((resolve) => { releaseChunk = resolve; });

    await unlockServer(page, "Media tester");
    await expect(page.locator('input[type="file"]')).toHaveAttribute("accept", "image/*,video/*");
    await page.route(/\/api\/admin\/server\/uploads\/[^/]+\/chunks\/1$/, async (route) => {
      announceSecondChunk();
      await secondChunkGate;
      await route.continue();
    });

    try {
      await page.locator('input[type="file"]').setInputFiles(PHOTO);
      await secondChunkStarted;
      const progress = page.locator(".wx-chat-attachment-progress");
      await expect(progress).toBeVisible();
      await expect.poll(() => progress.evaluate((node) => (node as HTMLProgressElement).value)).toBeGreaterThan(0);
      await expect.poll(() => progress.evaluate((node) => (node as HTMLProgressElement).value)).toBeLessThan(
        await progress.evaluate((node) => (node as HTMLProgressElement).max),
      );

      await page.locator('.wx-srv-chat-host button[aria-label="Close"]').click();
      await expect(page.locator(".wx-srv-thread")).toHaveCount(0);
      await unlockAgain(page);
      releaseChunk();

      const send = page.locator(".wx-chat-send-button");
      await expect(send).toBeEnabled();
      await send.click();
      const thumb = page.locator(".wx-srv-photo-thumb");
      await expect(thumb).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
      await thumb.click();
      await expect(page.locator(".wx-chat-lightbox")).toBeVisible();
      await expect(page.locator(".wx-chat-lightbox img")).toHaveAttribute("src", /\/media\//);
      await page.locator('.wx-chat-lightbox button[aria-label="Close image viewer"]').click();
      await expect(page.locator(".wx-chat-lightbox")).toHaveCount(0);
    } finally {
      releaseChunk();
      await page.unroute(/\/api\/admin\/server\/uploads\/[^/]+\/chunks\/1$/);
    }
  });

  test("MP4 and rotated MOV attachments become playable videos", async ({ page }) => {
    await unlockServer(page, "Video tester");
    await page.locator('input[type="file"]').setInputFiles([VIDEO, ROTATED_VIDEO]);
    await waitForUploads(page, 2);
    const send = page.locator(".wx-chat-send-button");
    await send.click();

    const videos = page.locator(".wx-srv-video");
    await waitForRenderedAttachments(page, ".wx-srv-video", 2);
    for (let index = 0; index < 2; index += 1) {
      const video = videos.nth(index);
      await video.evaluate((node) => {
        const element = node as HTMLVideoElement;
        element.muted = true;
        return element.play();
      });
      await expect.poll(() => video.evaluate((node) => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    }
  });

  test("voice recorder uploads a short note that can be played", async ({ page }) => {
    await unlockServer(page, "Voice tester");
    const draft = page.locator(".wx-chat-composer textarea");
    await draft.fill("Keep this draft for a separate message");
    const record = page.getByRole("button", { name: "Record a voice note" });
    await record.click();
    await expect(page.getByRole("button", { name: "Stop recording" })).toBeVisible();
    await expect(page.locator(".wx-srv-record-status")).toContainText("Recording");
    await page.waitForTimeout(2_100);
    const sentVoice = page.waitForResponse((response) =>
      response.url().endsWith("/api/admin/server/messages") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Stop recording" }).click();
    expect((await sentVoice).status()).toBe(201);

    const voice = page.locator(".wx-srv-voice");
    await waitForRenderedAttachments(page, ".wx-srv-voice", 1, 15_000);
    await expect(draft).toHaveValue("Keep this draft for a separate message");
    await expect(page.locator(".wx-chat-attachment-chip")).toHaveCount(0);
    await expect(voice.locator(".wx-srv-voice-time")).toContainText(/\/ 0:0[12]/);
    const audio = voice.locator("audio");
    await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
    await voice.getByRole("button", { name: "Play voice note" }).click();
    await expect.poll(() => audio.evaluate((node) => (node as HTMLAudioElement).currentTime)).toBeGreaterThan(0);
    const audioNode = await audio.elementHandle();
    expect(audioNode).not.toBeNull();
    await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
    await page.locator('.wx-srv-chat-host button[aria-label="Close"]').click();
    await expect(page.locator(".wx-srv-thread")).toHaveCount(0);
    const stopped = await audioNode!.evaluate((node) => ({
      paused: (node as HTMLAudioElement).paused,
      currentTime: (node as HTMLAudioElement).currentTime,
    }));
    expect(stopped.paused).toBe(true);
    await page.waitForTimeout(250);
    const afterDetach = await audioNode!.evaluate((node) => (node as HTMLAudioElement).currentTime);
    expect(afterDetach).toBeCloseTo(stopped.currentTime, 2);
    await audioNode!.dispose();
  });

  test("a voice note the server cannot accept never strands the mic, on a 360px phone (F17)", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    let sends = 0;
    await page.route("**/api/admin/server/messages", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      sends += 1;
      if (sends === 1) {
        // A transient failure: Retry stays offered, and so does Discard.
        await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
      } else if (sends === 2) {
        // The retry meets a definitive verdict (the attachment failed processing or was
        // reaped): it can never succeed, so the note is discarded and the mic is free.
        await route.fulfill({
          status: 422,
          contentType: "application/json",
          body: '{"error":"invalid","detail":"attachment x is unknown, already used, or failed"}',
        });
      } else {
        await route.fallback();
      }
    });
    // One fixture chat serves the whole spec file (no reset between tests), so count
    // only THIS run's own voice bubble: a unique sender name keeps it independent of
    // every voice note an earlier test left behind.
    await unlockServer(page, `Retry ${Date.now()}`);

    const record = page.getByRole("button", { name: "Record a voice note" });
    const retry = page.getByRole("button", { name: "Retry voice note" });
    const discard = page.getByRole("button", { name: "Discard voice note" });
    const draft = page.locator(".wx-chat-composer textarea");

    await record.click();
    await expect(page.getByRole("button", { name: "Stop recording" })).toBeVisible();
    await page.waitForTimeout(1_300);
    await page.getByRole("button", { name: "Stop recording" }).click();
    await expect(retry).toBeVisible();
    await expect(discard).toBeVisible();

    // Narrow-viewport layout: Retry and Discard sit on their own row, so the text field
    // keeps a usable width and nothing spills past the 360px viewport.
    const draftBox = await draft.boundingBox();
    expect(draftBox?.width ?? 0).toBeGreaterThan(120);
    for (const control of [retry, discard]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(record).toBeDisabled(); // a note is pending: no second recording yet

    await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
    await retry.click();
    await expect(page.locator(".wx-chat-composer-error")).toContainText("was discarded");
    await expect(retry).toBeHidden();
    await expect(discard).toBeHidden();
    await expect(record).toBeEnabled();

    // A new note can be recorded and now goes through.
    await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
    await record.click();
    await expect(page.getByRole("button", { name: "Stop recording" })).toBeVisible();
    await page.waitForTimeout(1_300);
    const sentVoice = page.waitForResponse((response) =>
      response.url().endsWith("/api/admin/server/messages") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Stop recording" }).click();
    expect((await sentVoice).status()).toBe(201);
    // The new note is sent and shown as this user's own message. Whether ffmpeg has
    // finished it is not F17's concern (the two intercepted attempts above left orphan
    // uploads queued ahead of it, which can take a while on a loaded host), so this
    // asserts the bubble, not the processed player.
    await expect(page.locator(".wx-srv-bubble-mine")).toHaveCount(1);
    await expect(
      page.locator(".wx-srv-bubble-mine .wx-srv-voice, .wx-srv-bubble-mine .wx-srv-attachment-processing"),
    ).toHaveCount(1);
    await expect(page.locator(".wx-chat-composer-error")).toBeHidden();
  });

  test("a failed voice note can simply be discarded (F17)", async ({ page }) => {
    await page.route("**/api/admin/server/messages", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
      } else {
        await route.fallback();
      }
    });
    await unlockServer(page, "Discard tester");
    const record = page.getByRole("button", { name: "Record a voice note" });
    await record.click();
    await expect(page.getByRole("button", { name: "Stop recording" })).toBeVisible();
    await page.waitForTimeout(1_300);
    await page.getByRole("button", { name: "Stop recording" }).click();

    const discard = page.getByRole("button", { name: "Discard voice note" });
    await expect(discard).toBeVisible();
    await expect(record).toBeDisabled();
    await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
    await discard.click();

    await expect(discard).toBeHidden();
    await expect(page.getByRole("button", { name: "Retry voice note" })).toBeHidden();
    await expect(page.locator(".wx-chat-composer-error")).toBeHidden();
    await expect(record).toBeEnabled();
  });

  test("voice recordings shorter than one second are discarded", async ({ page }) => {
    const uploadRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/admin/server/uploads")) uploadRequests.push(request.url());
    });
    await unlockServer(page, "Quick tester");
    await page.getByRole("button", { name: "Record a voice note" }).click();
    await expect(page.getByRole("button", { name: "Stop recording" })).toBeVisible();
    await page.waitForTimeout(650); // >400 ms tap window, but below the 1s minimum.
    await page.getByRole("button", { name: "Stop recording" }).click();

    await expect(page.locator(".wx-chat-composer-error")).toContainText("Too short");
    await expect(page.locator(".wx-chat-attachment-chip")).toHaveCount(0);
    expect(uploadRequests).toEqual([]);
  });
});
