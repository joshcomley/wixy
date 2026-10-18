// Real local browser/audio-worklet/socket loop with Chromium's synthetic microphone.
// This proves duplex transport and cleanup, not physical speakerphone quality.
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import { trackConsoleErrors } from "./helpers";

test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } });
test.describe.configure({ timeout: 90_000 });

async function unlock(page: Page, name: string): Promise<void> {
  const { pin } = await (await page.request.post("/test/server/config")).json() as { pin: string };
  await page.goto("/admin/server");
  await page.locator(".wx-srv-decoy").click();
  await page.waitForTimeout(450);
  await page.locator(".wx-srv-affordance").click();
  for (const digit of pin) await page.locator(`.wx-srv-pinpad-key-digit:text-is("${digit}")`).click();
  await page.locator(".wx-srv-pinpad-key-submit").click();
  await expect(page.locator(".wx-srv-name-prompt")).toBeVisible();
  await page.locator(".wx-srv-name-prompt-input").fill(name);
  await page.locator(".wx-srv-name-prompt-button").click();
  await expect(page.locator(".wx-srv-call")).toBeVisible();
}

interface Probe {
  streams: MediaStream[];
  analyser: AnalyserNode | null;
  context: AudioContext | null;
  failures: string[];
}
async function probe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as Window & { __voiceProbe?: Probe };
    const state: Probe = { streams: [], analyser: null, context: null, failures: [] };
    w.__voiceProbe = state;
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getMedia(constraints).catch((error: unknown) => {
        state.failures.push(`microphone: ${String(error)}`);
        throw error;
      });
      state.streams.push(stream);
      return stream;
    };
    const addModule = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = async function(url, options) {
      return addModule.call(this, url, options).catch((error: unknown) => {
        state.failures.push(`worklet: ${String(error)}`);
        throw error;
      });
    };
    const Native = AudioWorkletNode;
    window.AudioWorkletNode = class extends Native {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        try { super(context, name, options); }
        catch (error) { state.failures.push(`node: ${String(error)}`); throw error; }
        if (name === "wixy-call") {
          state.context = context as AudioContext;
          state.analyser = context.createAnalyser();
          this.connect(state.analyser);
        }
      }
    };
  });
}
async function rms(page: Page): Promise<number> {
  return page.evaluate(() => {
    const analyser = (window as Window & { __voiceProbe?: Probe }).__voiceProbe?.analyser;
    if (!analyser) return 0;
    const values = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(values);
    return Math.sqrt(values.reduce((total, x) => total + x * x, 0) / values.length);
  });
}
async function tracks(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as Window & { __voiceProbe?: Probe }).__voiceProbe?.streams
    .flatMap((stream) => stream.getTracks().map((track) => track.readyState)) ?? []);
}

test("duplex sound, muted idle pause, panic stop and fresh idle countdown", async ({ browser }) => {
  const a = await browser.newContext({ permissions: ["microphone"] });
  const b = await browser.newContext({ permissions: ["microphone"] });
  try {
    const pa = await a.newPage();
    const pb = await b.newPage();
    await probe(pa);
    await probe(pb);
    const errorsA = trackConsoleErrors(pa);
    const errorsB = trackConsoleErrors(pb);
    const received = [0, 0];
    const peaks = [0, 0];
    for (const [i, page] of [pa, pb].entries()) page.on("websocket", (ws) => {
      expect(new URL(ws.url()).search).toBe("");
      ws.on("framereceived", (frame) => {
        if (typeof frame.payload !== "string") {
          received[i]!++;
          for (let at = 48; at + 1 < frame.payload.length; at += 2) peaks[i] = Math.max(peaks[i]!, Math.abs(frame.payload.readInt16LE(at)));
        }
      });
    });
    await unlock(pa, "Caller");
    await unlock(pb, "Receiver");
    await expect(pa.getByLabel("Person to call").locator("option")).toHaveCount(1);
    await pa.locator(".wx-srv-call").getByRole("button", { name: "Call", exact: true }).click();
    await expect(pb.locator(".wx-srv-call")).toContainText("Incoming call");
    expect(await tracks(pa)).toEqual([]); // Consent before mic capture.
    expect(await tracks(pb)).toEqual([]);
    await pb.locator(".wx-srv-call").getByRole("button", { name: "Answer", exact: true }).click();
    for (const page of [pa, pb]) await expect.poll(() => page.evaluate(() => ({
      status: document.querySelector(".wx-srv-call")?.textContent,
      failures: (window as Window & { __voiceProbe?: Probe }).__voiceProbe?.failures,
    })), { timeout: 6000 }).toEqual({ status: expect.stringContaining("On a voice call"), failures: [] });
    await expect.poll(async () => {
      const level = await rms(pa);
      return level > 0.001 ? "audible" : JSON.stringify({ level, received, peaks,
        status: await pa.locator(".wx-srv-call").textContent() });
    }, { timeout: 6000, intervals: [50] }).toBe("audible");
    await expect.poll(() => rms(pb), { timeout: 6000, intervals: [50] }).toBeGreaterThan(0.001);
    expect(received.every((n) => n > 10)).toBe(true);
    // A stalled main thread must not release accumulated audio on return.
    await pa.evaluate(() => { const until = performance.now() + 450; while (performance.now() < until) { /* forced stall */ } });
    await expect(pb.locator(".wx-srv-call")).toContainText("Call ended");
    expect((await tracks(pa)).every((x) => x === "ended")).toBe(true);
    expect((await tracks(pb)).every((x) => x === "ended")).toBe(true);
    await pa.locator(".wx-srv-call").getByRole("button", { name: "Call", exact: true }).click();
    await pb.locator(".wx-srv-call").getByRole("button", { name: "Answer", exact: true }).click();
    for (const page of [pa, pb]) await expect(page.locator(".wx-srv-call")).toContainText("On a voice call");
    await pa.locator(".wx-srv-call").getByRole("button", { name: "Mute", exact: true }).click();
    await pb.locator(".wx-srv-call").getByRole("button", { name: "Mute", exact: true }).click();
    await pa.waitForTimeout(11_000); // Beyond default idle, without fake clock/network interference.
    for (const page of [pa, pb]) {
      await expect(page.locator(".wx-srv-call")).toContainText("On a voice call");
      await expect(page.locator(".wx-srv-thread")).toBeVisible();
    }
    await pa.keyboard.press("Escape");
    await expect(pa.locator(".wx-srv-thread")).toHaveCount(0);
    await expect(pb.locator(".wx-srv-call")).toContainText("Call ended");
    expect((await tracks(pa)).every((x) => x === "ended")).toBe(true);
    expect((await tracks(pb)).every((x) => x === "ended")).toBe(true);
    // Remote end releases idle pause with a FULL interval; it must not lock immediately.
    await expect(pb.locator(".wx-srv-thread")).toBeVisible();
    await pb.waitForTimeout(10_900);
    await expect(pb.locator(".wx-srv-thread")).toHaveCount(0);
    expect(errorsA).toEqual([]);
    expect(errorsB).toEqual([]);
  } finally { await a.close(); await b.close(); }
});
