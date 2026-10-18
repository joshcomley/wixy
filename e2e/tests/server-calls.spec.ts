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
  closes: number[];
  visibility: string[];
}
async function probe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as Window & { __voiceProbe?: Probe };
    const state: Probe = { streams: [], analyser: null, context: null, failures: [], closes: [], visibility: [] };
    w.__voiceProbe = state;
    document.addEventListener("visibilitychange", () => state.visibility.push(document.visibilityState));
    const NativeSocket = WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("close", (event) => state.closes.push(event.code));
      }
    };
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
  const c = await browser.newContext({ permissions: ["microphone"] });
  let observerActivity: ReturnType<typeof setInterval> | null = null;
  let stage = "unlock devices";
  try {
    const pa = await a.newPage();
    const pb = await b.newPage();
    const pc = await c.newPage();
    await probe(pa);
    await probe(pb);
    await probe(pc);
    const errorsA = trackConsoleErrors(pa);
    const errorsB = trackConsoleErrors(pb);
    const errorsC = trackConsoleErrors(pc);
    const received = [0, 0, 0];
    const peaks = [0, 0, 0];
    for (const [i, page] of [pa, pb, pc].entries()) page.on("websocket", (ws) => {
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
    await unlock(pc, "Observer");
    await pa.setViewportSize({ width: 390, height: 844 });
    await expect(pa.locator(".wx-srv-call select")).toHaveCount(0);
    expect(await pa.evaluate(() => document.querySelector(".wx-srv-more-button")?.nextElementSibling
      === document.querySelector(".wx-srv-call"))).toBe(true);
    const observerBox = await pc.locator(".wx-srv-thread").boundingBox();
    if (!observerBox) throw new Error("Observer chat did not open");
    // Keep the unrelated unlocked view active. Neither call endpoint gets activity,
    // so the muted-call idle test still discriminates a real countdown suspension.
    observerActivity = setInterval(() => {
      void pc.mouse.move(observerBox.x + observerBox.width / 2 + Math.random() * 3,
        observerBox.y + observerBox.height / 2).catch((error: unknown) => errorsC.push(String(error)));
    }, 1000);
    stage = "load worklet and choose receiver";
    const asset = await pa.request.get("/admin/static/admin/call-worklet.js");
    expect(asset.status()).toBe(200);
    expect(asset.headers()["content-type"]).toMatch(/javascript|ecmascript/);
    await pa.locator(".wx-srv-call").getByRole("button", { name: "Call", exact: true }).click();
    await expect(pa.getByRole("radio")).toHaveCount(2);
    await expect(pb.locator(".wx-srv-call").getByRole("button", { name: "Answer", exact: true })).toBeHidden();
    expect(await tracks(pa)).toEqual([]);
    const confirmationBox = await pa.getByRole("dialog", { name: "Start a call" }).boundingBox();
    expect(confirmationBox?.x).toBeGreaterThanOrEqual(0);
    expect((confirmationBox?.x ?? 0) + (confirmationBox?.width ?? 0)).toBeLessThanOrEqual(390);
    await pa.screenshot({ path: test.info().outputPath("call-confirmation-phone.png") });
    await pa.getByRole("radio", { name: /Receiver/ }).check();
    stage = "connect and render duplex audio";
    await pa.getByRole("button", { name: "Confirm call", exact: true }).click();
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
    expect(received[0]).toBeGreaterThan(10);
    expect(received[1]).toBeGreaterThan(10);
    expect(received[2]).toBe(0);
    await expect(pc.locator(".wx-srv-call").getByRole("button", { name: "Answer", exact: true })).toBeHidden();
    expect(await tracks(pc)).toEqual([]);
    await expect(pa.locator(".wx-srv-call")).toContainText("On a voice call");
    await expect(pb.locator(".wx-srv-call")).toContainText("On a voice call");
    // A stalled main thread must not release accumulated audio on return.
    stage = "force stall and obtain fresh consent";
    await pa.evaluate(() => { const until = performance.now() + 450; while (performance.now() < until) { /* forced stall */ } });
    await expect(pb.locator(".wx-srv-call")).toContainText("Call ended");
    expect((await tracks(pa)).every((x) => x === "ended")).toBe(true);
    expect((await tracks(pb)).every((x) => x === "ended")).toBe(true);
    for (const [name, page] of [["caller", pa], ["receiver", pb]] as const) {
      const lifecycle = await page.evaluate(() => {
        const p = (window as Window & { __voiceProbe?: Probe }).__voiceProbe;
        return { call: document.querySelector(".wx-srv-call")?.textContent, closes: p?.closes,
          visibility: p?.visibility, context: p?.context?.state };
      });
      console.log(`After forced stall ${name}: ${JSON.stringify(lifecycle)}`);
      await expect(page.locator(".wx-srv-thread")).toBeVisible();
    }
    await pa.locator(".wx-srv-call").getByRole("button", { name: "Call", exact: true }).click({ timeout: 5000 });
    await pa.getByRole("button", { name: "Confirm call", exact: true }).click();
    await pb.locator(".wx-srv-call").getByRole("button", { name: "Answer", exact: true }).click();
    for (const page of [pa, pb]) await expect(page.locator(".wx-srv-call")).toContainText("On a voice call");
    await pa.locator(".wx-srv-call").getByRole("button", { name: "Mute", exact: true }).click();
    await pb.locator(".wx-srv-call").getByRole("button", { name: "Mute", exact: true }).click();
    stage = "muted idle and third-device isolation";
    await pa.waitForTimeout(11_000); // Beyond default idle, without fake clock/network interference.
    for (const page of [pa, pb]) {
      await expect(page.locator(".wx-srv-call")).toContainText("On a voice call");
      await expect(page.locator(".wx-srv-thread")).toBeVisible();
    }
    await expect(pc.locator(".wx-srv-thread")).toBeVisible();
    await expect(pc.locator(".wx-srv-call")).not.toContainText("Incoming call");
    expect(received[2]).toBe(0);
    expect(await tracks(pc)).toEqual([]);
    await pa.keyboard.press("Escape");
    stage = "panic teardown and fresh remote countdown";
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
    expect(errorsC).toEqual([]);
  } catch (error) {
    console.error(`Voice test failed at ${stage}: ${String(error)}`);
    throw error;
  } finally {
    if (observerActivity !== null) clearInterval(observerActivity);
    await Promise.all([a.close(), b.close(), c.close()]);
  }
});

// Run after the sustained scenario: its shared fixture's admission bucket has
// replenished, so this case measures lifecycle rather than repeated-login throttling.
test("persisted page recovery preserves draft and restores presence without audio", async ({ page }) => {
  await probe(page);
  let sockets = 0;
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname === "/api/admin/server/calls/ws") sockets++;
  });
  await unlock(page, "Cache test");
  const draft = page.locator(".wx-srv-thread-view textarea");
  await draft.fill("Unsent draft survives page recovery");
  await expect.poll(() => sockets).toBe(1);
  await page.evaluate(() => {
    localStorage.setItem("wx-srv-lock-on-tab", "0");
    localStorage.setItem("wx-srv-lock-on-screen", "0");
    window.dispatchEvent(new Event("wx-srv-lock-prefs-changed"));
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
  });
  await expect(page.locator(".wx-srv-call")).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.locator(".wx-srv-call")).toBeVisible({ timeout: 2000 });
  await expect(draft).toHaveValue("Unsent draft survives page recovery");
  await expect.poll(() => sockets).toBe(2);
  expect(await tracks(page)).toEqual([]);
  expect(await page.evaluate(() => (window as Window & { __voiceProbe?: Probe }).__voiceProbe?.context)).toBeNull();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  expect(sockets).toBe(2);
  await page.keyboard.press("Escape");
  await expect(page.locator(".wx-srv-thread")).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  expect(sockets).toBe(2);
});

test("microphone rejection explains setup failure on both devices with safe copyable details", async ({ browser }) => {
  const caller = await browser.newContext({ permissions: ["microphone"] });
  const callee = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["microphone"] });
  try {
    const a = await caller.newPage();
    const b = await callee.newPage();
    await b.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("private-error-content", "NotAllowedError"); };
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    });
    await unlock(a, "Caller");
    await unlock(b, "Receiver");
    await a.getByRole("button", { name: "Call", exact: true }).click();
    await a.getByRole("button", { name: "Confirm call", exact: true }).click();
    await b.getByRole("button", { name: "Answer", exact: true }).click();
    const local = b.locator(".wx-srv-call-notice");
    await expect(local).toBeVisible();
    await expect(local).toContainText("permission was denied");
    await expect(a.locator(".wx-srv-call-notice")).toContainText("other device couldn't connect the call");
    await local.getByRole("button", { name: "Copy call details" }).click();
    await expect(local.locator("pre")).toBeVisible();
    await expect(local.locator("pre")).toContainText("NotAllowedError");
    await expect(local.locator("pre")).not.toContainText("private-error-content");
    const box = await local.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    await b.screenshot({ path: test.info().outputPath("call-setup-diagnostics-phone.png") });
    await b.getByRole("button", { name: "Dismiss call details" }).click();
    await expect(b.locator(".wx-srv-call-notice")).toBeHidden();
  } finally { await Promise.all([caller.close(), callee.close()]); }
});
