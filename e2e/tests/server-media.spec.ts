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

async function waitForRenderedAttachments(page: Page, selector: string, expectedCount: number): Promise<void> {
  const attachments = page.locator(selector);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await attachments.count() === expectedCount) return;
    await page.mouse.move(24 + attempt, 24 + attempt);
    await page.waitForTimeout(250);
  }
  await expect(attachments).toHaveCount(expectedCount);
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
    const record = page.getByRole("button", { name: "Record a voice note" });
    await record.click();
    await expect(page.getByRole("button", { name: "Stop recording" })).toBeVisible();
    await expect(page.locator(".wx-srv-record-status")).toContainText("Recording");
    await page.waitForTimeout(2_100);
    await page.getByRole("button", { name: "Stop recording" }).click();

    const chip = page.locator(".wx-chat-attachment-chip");
    await expect(chip).toContainText("Voice note");
    await waitForUploads(page, 1);
    await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
    await page.locator(".wx-chat-send-button").click();

    const voice = page.locator(".wx-srv-voice");
    await waitForRenderedAttachments(page, ".wx-srv-voice", 1);
    await expect(voice.locator(".wx-srv-voice-time")).toContainText(/\/ 0:0[12]/);
    const audio = voice.locator("audio");
    await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
    await voice.getByRole("button", { name: "Play voice note" }).click();
    await expect.poll(() => audio.evaluate((node) => (node as HTMLAudioElement).currentTime)).toBeGreaterThan(0);
  });
});
