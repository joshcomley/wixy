// spec/server-chat/07-live-voice-notes.md §5: the synthetic two-browser acceptance proof of live
// voice notes. ONE fixture server, TWO browser contexts (a sender and a listener) unlocked into
// the same Server chat as different people, talking through the real local HTTP + WebSocket
// (`/api/admin/server/live-voice/ws`). The microphone is Chromium's fake audio device, ffmpeg on
// the server is the real one, transcription goes through the fixture's fake private cmd.
//
// What this proves is transport and behaviour: the message appears while recording, the waveform
// grows, the listener's own position advances and the audio worklet puts real signal on its
// output while the sender is still recording, Paused / resume, Stop turning the bubble into the
// finished note, live and then final transcription, Delete for everyone. It does NOT prove
// speaker or microphone quality on a phone or over the real tunnel: that is spec 07 §5's
// physical-device gate, observed by a person.
//
// Waits are explicit, bounded and on observable conditions (a locator, or `expect.poll` on what
// the page shows); the one fixed pause is the "nothing grew while paused" window, which can only
// be a window of time.

import { expect, test } from "../fixtures";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";

const MULTI_TAP_INTERVAL_MS = 400;
/** Every gesture pair is spaced past the multi-tap window, or the chat would (correctly) lock. */
const TAP_GAP_MS = MULTI_TAP_INTERVAL_MS + 100;
const DESKTOP = { width: 1280, height: 800 } as const;
const PHONE = { width: 402, height: 870 } as const;
/** Generous: the box that runs this is often loaded, and every wait below exits as soon as it can. */
const SLOW_MS = 30_000;

const LIVE_TEXT = "Live words so far. And the unfinished tail";
const LIVE_FINAL_PART = "Live words so far.";
const LIVE_TAIL_PART = "And the unfinished tail";
const FINAL_TEXT = "The final stored transcript of the whole note.";

test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
});
test.describe.configure({ timeout: 180_000 });

// ---------------------------------------------------------------------------------------------
// Setup: unlock, devices, fake cmd
// ---------------------------------------------------------------------------------------------

interface Stats {
  requests: number;
  retained: number;
  lastFields: Record<string, string> | null;
  lastAudioBytes: number;
  lastAudioIsMp4: boolean;
  lastAudioIsWav: boolean;
  wavRequests: number;
}

async function configureCmd(page: Page, body: Record<string, unknown>): Promise<Stats> {
  const response = await page.request.post("/test/server/transcribe-config", { data: body });
  expect(response.ok()).toBe(true);
  return (await response.json()) as Stats;
}

async function cmdStats(page: Page): Promise<Stats> {
  return (await (await page.request.post("/test/server/transcribe-stats")).json()) as Stats;
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

/** Unlock the chat and set the display name (the first unlock of this browser context). */
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

/** Pointer activity restarts the chat's 10-second idle lock; a device that is only being watched,
 * or one whose owner is "speaking", would otherwise lock while the other one works. */
function keepAwake(page: Page): { start(): void; stop(): void } {
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        void page.mouse.move(150 + Math.floor(Math.random() * 3), 300).catch(() => undefined);
      }, 1000);
    },
    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}

interface Device {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly awake: { start(): void; stop(): void };
}

/** Everything the listener's audio output carries, observable without a speaker: the live-voice
 * worklet's output is tapped by an analyser and its loudest block since the last reset is kept. */
async function installAudioProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Probe { maxRms: number; nodes: number }
    const w = window as Window & { __liveProbe?: Probe };
    const state: Probe = { maxRms: 0, nodes: 0 };
    w.__liveProbe = state;
    const Native = AudioWorkletNode;
    window.AudioWorkletNode = class extends Native {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        if (name !== "wixy-live-voice") return;
        state.nodes += 1;
        const analyser = context.createAnalyser();
        this.connect(analyser);
        const values = new Float32Array(analyser.fftSize);
        setInterval(() => {
          analyser.getFloatTimeDomainData(values);
          let sum = 0;
          for (const x of values) sum += x * x;
          state.maxRms = Math.max(state.maxRms, Math.sqrt(sum / values.length));
        }, 40);
      }
    };
  });
}

async function resetProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __liveProbe: { maxRms: number } }).__liveProbe.maxRms = 0;
  });
}

async function probeRms(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __liveProbe: { maxRms: number } }).__liveProbe.maxRms);
}

async function newDevice(
  browser: Browser,
  viewport: { width: number; height: number },
  name: string,
  options: { probe?: boolean } = {},
): Promise<Device> {
  const context = await browser.newContext({ viewport, permissions: ["microphone"] });
  const page = await context.newPage();
  if (options.probe === true) await installAudioProbe(page);
  await unlock(page, name);
  return { context, page, awake: keepAwake(page) };
}

// ---------------------------------------------------------------------------------------------
// What a person sees
// ---------------------------------------------------------------------------------------------

const mic = (page: Page): Locator => page.locator(".wx-srv-record-button");
const recordStatus = (page: Page): Locator => page.locator(".wx-srv-record-status");
const menu = (page: Page): Locator => page.getByRole("menu", { name: "Voice note type" });
/** One choice in the mode menu, by the exact words it shows. */
const modeItem = (page: Page, label: "Voice note" | "Live voice note"): Locator =>
  menu(page).locator("[role='menuitemradio']").filter({ hasText: new RegExp(`^${label}$`) });
const liveBubble =(page: Page): Locator => page.locator(".wx-srv-voice-live");
const bars = (page: Page): Locator => liveBubble(page).locator(".wx-srv-voice-waveform-bar");

function note(page: Page, seq: number): Locator {
  return page.locator(`[data-message-seq="${seq}"]`);
}

/** "m:ss" -> seconds. */
function seconds(text: string): number {
  const match = /(\d+):(\d{2})/.exec(text);
  if (match === null) throw new Error(`no m:ss in "${text}"`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** The listener's live bubble shows `0:09 / 0:23` while it is playing, only `0:23` otherwise. */
async function liveClock(page: Page): Promise<{ position: number | null; total: number }> {
  const text = (await liveBubble(page).locator(".wx-srv-voice-time").textContent()) ?? "";
  const parts = text.match(/\d+:\d{2}/g) ?? [];
  if (parts.length === 0) throw new Error(`no clock in "${text}"`);
  if (parts.length === 1) return { position: null, total: seconds(parts[0]!) };
  return { position: seconds(parts[0]!), total: seconds(parts[1]!) };
}

async function longPressMic(page: Page): Promise<void> {
  await mic(page).hover();
  await page.mouse.down();
  // The menu opens from the held press (500 ms); wait for IT, never a fixed time.
  await expect(menu(page)).toBeVisible({ timeout: SLOW_MS });
  await page.mouse.up();
}

async function chooseMode(page: Page, label: "Voice note" | "Live voice note"): Promise<void> {
  await longPressMic(page);
  await page.waitForTimeout(TAP_GAP_MS);
  await modeItem(page, label).click();
  await expect(menu(page)).toBeHidden();
  await page.waitForTimeout(TAP_GAP_MS);
}

async function liveMessageSeq(page: Page): Promise<number> {
  const attribute = await liveBubble(page).first().evaluate((node) =>
    node.closest("[data-message-seq]")?.getAttribute("data-message-seq") ?? "",
  );
  expect(attribute).toMatch(/^\d+$/);
  return Number(attribute);
}

async function startLive(sender: Page): Promise<void> {
  await chooseMode(sender, "Live voice note");
  await expect(mic(sender)).toHaveClass(/wx-srv-record-button--live/);
  await expect(mic(sender)).toHaveAttribute("aria-label", "Record a live voice note");
  await mic(sender).click();
  await expect(recordStatus(sender)).toContainText(/LIVE · \d+:\d{2}/, { timeout: SLOW_MS });
  await expect(sender.getByRole("button", { name: "Stop live voice note" })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await configureCmd(page, { private: true, hold: false, status: 200, text: LIVE_TEXT, reset: true });
});

test.afterEach(async ({ page }) => {
  await configureCmd(page, { private: false, hold: false, status: 200 });
});

// ---------------------------------------------------------------------------------------------
// 1. The mic's mode switch (one device)
// ---------------------------------------------------------------------------------------------

test.describe("server-live-voice.spec.ts: the microphone's mode switch", () => {
  test.use({ viewport: DESKTOP });

  test("a long press offers Voice note and Live voice note, Live marks the mic, a plain tap records a normal note", async ({ browser }) => {
    const device = await newDevice(browser, DESKTOP, "Switcher");
    const { page } = device;
    try {
      // Default: the plain mic, no LIVE marker.
      await expect(mic(page)).toHaveAttribute("aria-label", "Record a voice note");
      await expect(mic(page)).not.toHaveClass(/wx-srv-record-button--live/);

      // Long-press: both choices are offered, the current one is checked, and the press that
      // opened the menu does not also start a recording.
      await longPressMic(page);
      const voiceItem = modeItem(page, "Voice note");
      const liveItem = modeItem(page, "Live voice note");
      await expect(voiceItem).toBeVisible();
      await expect(liveItem).toBeVisible();
      await expect(voiceItem).toHaveAttribute("aria-checked", "true");
      await expect(liveItem).toHaveAttribute("aria-checked", "false");
      await expect(recordStatus(page)).toBeHidden();

      // Choosing Live puts the red LIVE marker on the mic, and the marker is really drawn.
      await page.waitForTimeout(TAP_GAP_MS);
      await liveItem.click();
      await expect(menu(page)).toBeHidden();
      await expect(mic(page)).toHaveClass(/wx-srv-record-button--live/);
      await expect(mic(page)).toHaveAttribute("aria-label", "Record a live voice note");
      await expect(recordStatus(page)).toBeHidden();
      const marker = await mic(page).evaluate((node) => {
        const dot = getComputedStyle(node, "::after");
        return { content: dot.content, width: dot.width, radius: dot.borderRadius, colour: dot.backgroundColor };
      });
      expect(marker.content).not.toBe("none");
      expect(marker.width).toBe("8px");
      expect(marker.colour).not.toBe("rgba(0, 0, 0, 0)");

      // Back to Voice note: the marker goes, and a plain tap records an ordinary note.
      await chooseMode(page, "Voice note");
      await expect(mic(page)).not.toHaveClass(/wx-srv-record-button--live/);
      await expect(mic(page)).toHaveAttribute("aria-label", "Record a voice note");
      await mic(page).click();
      await expect(recordStatus(page)).toContainText(/Recording \d+:\d{2}/, { timeout: SLOW_MS });
      await expect(recordStatus(page)).not.toContainText("LIVE");
      await expect(page.getByRole("button", { name: "Stop and send recording" })).toBeVisible();
      device.awake.start();
      await expect.poll(async () => seconds((await recordStatus(page).textContent()) ?? ""), { timeout: SLOW_MS })
        .toBeGreaterThanOrEqual(2);
      await page.getByRole("button", { name: "Stop and send recording" }).click();
      const voice = page.locator(".wx-srv-voice");
      await expect(voice).toBeVisible({ timeout: SLOW_MS });
      // A normal note: never a live bubble, no LIVE badge, and it plays.
      await expect(page.locator(".wx-srv-voice-live")).toHaveCount(0);
      await expect(page.locator(".wx-srv-live-badge")).toHaveCount(0);
      await expect(voice.getByRole("button", { name: "Play voice note" })).toBeVisible({ timeout: SLOW_MS });
    } finally {
      device.awake.stop();
      await device.context.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 2-6. One live note, start to finish, sender + listener
// ---------------------------------------------------------------------------------------------

for (const [label, viewport] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(`server-live-voice.spec.ts (${label} ${viewport.width}x${viewport.height})`, () => {
    test.use({ viewport });

    test("a live note is heard while it is recorded: appears, grows, plays, pauses, transcribes live, and ends as a normal note", async ({ browser, page: fixturePage }) => {
      const sender = await newDevice(browser, viewport, `Sender ${label}`);
      const listener = await newDevice(browser, viewport, `Listener ${label}`, { probe: true });
      const s = sender.page;
      const l = listener.page;
      try {
        // -- 1. Live mode, then record --------------------------------------------------------
        await startLive(s);
        sender.awake.start();
        listener.awake.start();

        // -- 2. The listener sees it appear while recording is under way ------------------------
        await expect(liveBubble(l)).toBeVisible({ timeout: SLOW_MS });
        await expect(liveBubble(l).locator(".wx-srv-live-badge")).toHaveText("LIVE");
        await expect(liveBubble(l)).toHaveAttribute("data-state", "recording");
        // The sender is still recording at this moment.
        await expect(recordStatus(s)).toContainText("LIVE");
        const seq = await liveMessageSeq(l);
        // The sender's own bubble grows the same waveform but never offers Play (a phone must not
        // play the microphone it is recording into).
        await expect(liveBubble(s)).toBeVisible({ timeout: SLOW_MS });
        await expect(liveBubble(s).getByRole("button", { name: /Play live voice note/ })).toBeHidden();
        await expect(liveBubble(s).getByRole("button", { name: "Jump to live" })).toBeHidden();

        // The waveform grows over a few seconds.
        await expect.poll(() => bars(l).count(), { timeout: SLOW_MS }).toBeGreaterThanOrEqual(1);
        const barsAtFirstSight = await bars(l).count();
        await expect.poll(() => bars(l).count(), { timeout: SLOW_MS }).toBeGreaterThanOrEqual(barsAtFirstSight + 2);
        // ...and what it draws is the sender's real (fake-microphone) signal, not an empty row.
        const heights = await bars(l).evaluateAll((nodes) =>
          nodes.map((node) => Number((node as HTMLElement).style.getPropertyValue("--wx-srv-wave-height"))),
        );
        expect(Math.max(...heights)).toBeGreaterThan(0.08);

        // -- 3. Jump to live: playback advances while the sender is still recording --------------
        await resetProbe(l);
        await l.waitForTimeout(TAP_GAP_MS);
        await liveBubble(l).getByRole("button", { name: "Jump to live" }).click();
        await expect(liveBubble(l).getByRole("button", { name: "Pause live voice note" })).toBeVisible({ timeout: SLOW_MS });
        await expect.poll(async () => (await liveClock(l)).position, { timeout: SLOW_MS }).not.toBeNull();
        const firstPosition = (await liveClock(l)).position ?? 0;
        await expect.poll(async () => (await liveClock(l)).position ?? 0, { timeout: SLOW_MS })
          .toBeGreaterThanOrEqual(firstPosition + 2);
        // Real sound reached the worklet's output...
        await expect.poll(() => probeRms(l), { timeout: SLOW_MS }).toBeGreaterThan(0.02);
        // ...while the sender is still recording.
        await expect(recordStatus(s)).toContainText(/LIVE · \d+:\d{2}/);
        await expect(sender.page.getByRole("button", { name: "Stop live voice note" })).toBeVisible();

        // -- 4. Pause: "Paused"; resume: it grows again -----------------------------------------
        await s.waitForTimeout(TAP_GAP_MS);
        await s.getByRole("button", { name: "Pause recording" }).click();
        await expect(recordStatus(s)).toContainText("Paused");
        await expect(liveBubble(l).locator(".wx-srv-live-status")).toHaveText("Paused", { timeout: SLOW_MS });
        await expect(liveBubble(l)).toHaveAttribute("data-state", "paused");
        // Nothing grows while paused. This is a window of time, not a wait for a condition: let
        // the last flushed second settle, then look twice.
        await l.waitForTimeout(2_000);
        const pausedBars = await bars(l).count();
        const pausedTotal = (await liveClock(l)).total;
        await l.waitForTimeout(2_500);
        expect(await bars(l).count()).toBe(pausedBars);
        expect((await liveClock(l)).total).toBe(pausedTotal);
        await expect(liveBubble(l).locator(".wx-srv-live-status")).toHaveText("Paused");

        await s.waitForTimeout(TAP_GAP_MS);
        await s.getByRole("button", { name: "Resume recording" }).click();
        await expect(recordStatus(s)).toContainText(/LIVE · \d+:\d{2}/);
        await expect(recordStatus(s)).not.toContainText("Paused");
        await expect(liveBubble(l).locator(".wx-srv-live-status")).toBeHidden({ timeout: SLOW_MS });
        await expect(liveBubble(l)).toHaveAttribute("data-state", "recording");
        await expect.poll(() => bars(l).count(), { timeout: SLOW_MS }).toBeGreaterThanOrEqual(pausedBars + 2);
        await expect.poll(async () => (await liveClock(l)).total, { timeout: SLOW_MS }).toBeGreaterThan(pausedTotal + 1);

        // -- 6. Live transcription: Transcribe while live, live text, then the stored one --------
        await l.waitForTimeout(TAP_GAP_MS);
        await note(l, seq).getByRole("button", { name: "Transcribe this voice note" }).click();
        const finalised = note(l, seq).locator(".wx-srv-transcript-live .wx-srv-transcript-final");
        const tail = note(l, seq).locator(".wx-srv-transcript-live .wx-srv-transcript-tail");
        await expect(finalised).toContainText(LIVE_FINAL_PART, { timeout: 90_000 });
        await expect(tail).toHaveText(LIVE_TAIL_PART, { timeout: SLOW_MS });
        // The note is still being recorded, and the live pass went to cmd the way Inv 50 demands:
        // a private temporary WAV that cmd was told not to keep.
        await expect(liveBubble(l)).toHaveAttribute("data-state", "recording");
        const live = await cmdStats(fixturePage);
        expect(live.wavRequests).toBeGreaterThanOrEqual(1);
        expect(live.lastFields).toEqual({ private: "1", cleanup: "0" });
        expect(live.lastAudioIsWav).toBe(true);
        expect(live.lastAudioBytes).toBeGreaterThan(10_000);
        expect(live.retained).toBe(0);
        // After Stop, the full-note pass says this instead.
        await configureCmd(fixturePage, { text: FINAL_TEXT });

        // -- 5. Stop: the bubble becomes the normal finished voice note ----------------------------
        // The sender's own clock is the recorded length (paused time excluded).
        const recordedS = seconds((await recordStatus(s).textContent()) ?? "");
        expect(recordedS).toBeGreaterThanOrEqual(8);
        await s.waitForTimeout(TAP_GAP_MS);
        await s.getByRole("button", { name: "Stop live voice note" }).click();

        const finished = note(l, seq).locator(".wx-srv-voice:not(.wx-srv-voice-live)");
        await expect(finished).toBeVisible({ timeout: 60_000 });
        await expect(note(l, seq).locator(".wx-srv-live-badge")).toHaveCount(0);
        await expect(note(l, seq).locator(".wx-srv-voice-live")).toHaveCount(0);
        const audio = finished.locator("audio");
        await expect.poll(() => audio.evaluate((node) => (node as HTMLAudioElement).duration), { timeout: SLOW_MS })
          .toBeGreaterThan(0);
        const duration = await audio.evaluate((node) => (node as HTMLAudioElement).duration);
        expect(Math.abs(duration - recordedS)).toBeLessThanOrEqual(3);
        await expect(finished.locator(".wx-srv-voice-time")).toContainText(/\/ \d+:\d{2}/);
        const shownTotal = seconds(((await finished.locator(".wx-srv-voice-time").textContent()) ?? "").split("/").pop() ?? "");
        expect(Math.abs(shownTotal - recordedS)).toBeLessThanOrEqual(3);

        // It can be played (the listener may already have been carried over to the file; Play
        // on a note that has finished plays it again, so either way the position must advance).
        await l.waitForTimeout(TAP_GAP_MS);
        const playButton = finished.getByRole("button", { name: "Play voice note" });
        if (await playButton.isVisible()) await playButton.click();
        await expect.poll(() => audio.evaluate((node) => (node as HTMLAudioElement).currentTime), { timeout: SLOW_MS })
          .toBeGreaterThan(0);
        const heardAt = await audio.evaluate((node) => (node as HTMLAudioElement).currentTime);
        await expect.poll(() => audio.evaluate((node) => (node as HTMLAudioElement).currentTime), { timeout: SLOW_MS })
          .not.toBe(heardAt);
        // The sender's own bubble is the finished note as well.
        await expect(note(s, seq).locator(".wx-srv-voice:not(.wx-srv-voice-live)")).toBeVisible({ timeout: SLOW_MS });
        await expect(note(s, seq).locator(".wx-srv-live-badge")).toHaveCount(0);

        // Transcription: the live text is replaced by the normal stored transcript.
        const stored = note(l, seq).locator(".wx-srv-transcript-text:not(.wx-srv-transcript-live)");
        await expect(stored).toHaveText(FINAL_TEXT, { timeout: 90_000 });
        await expect(note(l, seq).locator(".wx-srv-transcript-live")).toHaveCount(0);
        await expect(note(l, seq).locator(".wx-srv-transcript-tail")).toHaveCount(0);
        await expect(note(l, seq).getByRole("button", { name: "Hide transcript" })).toBeVisible();
        const final = await cmdStats(fixturePage);
        expect(final.lastAudioIsMp4).toBe(true);
        expect(final.retained).toBe(0);
        expect(final.lastFields).toEqual({ private: "1", cleanup: "0" });
      } finally {
        sender.awake.stop();
        listener.awake.stop();
        await sender.context.close();
        await listener.context.close();
      }
    });

    // -------------------------------------------------------------------------------------------
    // 7. Delete for everyone
    // -------------------------------------------------------------------------------------------

    test("Delete for everyone removes a live note the listener is playing from the start", async ({ browser }) => {
      const sender = await newDevice(browser, viewport, `Deleter ${label}`);
      const listener = await newDevice(browser, viewport, `Hearer ${label}`, { probe: true });
      const s = sender.page;
      const l = listener.page;
      try {
        await startLive(s);
        sender.awake.start();
        listener.awake.start();
        await expect(liveBubble(l)).toBeVisible({ timeout: SLOW_MS });
        const seq = await liveMessageSeq(l);
        // Let it have some audio, then Play from the START (not Jump to live).
        await expect.poll(() => bars(l).count(), { timeout: SLOW_MS }).toBeGreaterThanOrEqual(3);
        await l.waitForTimeout(TAP_GAP_MS);
        await resetProbe(l);
        await liveBubble(l).getByRole("button", { name: "Play live voice note from the start" }).click();
        await expect(liveBubble(l).getByRole("button", { name: "Pause live voice note" })).toBeVisible({ timeout: SLOW_MS });
        await expect.poll(async () => (await liveClock(l)).position, { timeout: SLOW_MS }).not.toBeNull();
        const from = (await liveClock(l)).position ?? 0;
        // Joining at the start, so the position is near the beginning of a note that is longer.
        expect(from).toBeLessThanOrEqual(2);
        await expect.poll(async () => (await liveClock(l)).position ?? 0, { timeout: SLOW_MS }).toBeGreaterThanOrEqual(from + 2);
        await expect.poll(() => probeRms(l), { timeout: SLOW_MS }).toBeGreaterThan(0.02);

        // The sender's Cancel has become Delete for everyone, and it asks first.
        sender.awake.stop();
        await s.waitForTimeout(TAP_GAP_MS);
        await s.getByRole("button", { name: "Delete for everyone", exact: true }).first().click();
        const confirm = s.getByRole("alertdialog", { name: "Delete live voice note for everyone" });
        await expect(confirm).toBeVisible();
        await expect(confirm).toContainText("They may already have heard part of it");
        // "Keep recording" keeps it: the note is still there, still live, still recording.
        await s.waitForTimeout(TAP_GAP_MS);
        await confirm.getByRole("button", { name: "Keep recording" }).click();
        await expect(confirm).toBeHidden();
        await expect(recordStatus(s)).toContainText(/LIVE · \d+:\d{2}/);
        await expect(note(l, seq)).toBeVisible();
        await expect(liveBubble(l)).toHaveAttribute("data-state", "recording");

        // Delete it for real.
        sender.awake.start();
        await s.waitForTimeout(TAP_GAP_MS);
        await s.getByRole("button", { name: "Delete for everyone", exact: true }).first().click();
        await expect(confirm).toBeVisible();
        await s.waitForTimeout(TAP_GAP_MS);
        await confirm.getByRole("button", { name: "Delete for everyone", exact: true }).click();

        // Gone for the listener, who was hearing it, and for the sender.
        await expect(note(l, seq)).toHaveCount(0, { timeout: SLOW_MS });
        await expect(liveBubble(l)).toHaveCount(0);
        await expect(note(s, seq)).toHaveCount(0, { timeout: SLOW_MS });
        await expect(recordStatus(s)).toBeHidden({ timeout: SLOW_MS });
        await expect(mic(s)).toHaveAttribute("aria-label", "Record a live voice note");
        // The listener's audio stopped with it: the output goes quiet.
        await resetProbe(l);
        await l.waitForTimeout(1_500);
        expect(await probeRms(l)).toBeLessThan(0.002);
      } finally {
        sender.awake.stop();
        listener.awake.stop();
        await sender.context.close();
        await listener.context.close();
      }
    });
  });
}
