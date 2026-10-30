// SCRATCH repro for workspace 60 (canvas visibility). Not for commit.
import { expect, test } from "../fixtures";
import { chromium, devices, webkit, type Browser, type Page } from "@playwright/test";

test.describe.configure({ timeout: 180_000 });

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
  for (const digit of pin) await page.locator(`.wx-srv-pinpad-key-digit:text-is("${digit}")`).click();
  await page.locator(".wx-srv-pinpad-key-submit").click();
  await expect(page.locator(".wx-srv-name-prompt:visible, .wx-srv-thread:visible")).toBeVisible({ timeout: 5000 });
  if (await page.locator(".wx-srv-name-prompt").isVisible()) {
    await page.locator(".wx-srv-name-prompt-input").fill(name);
    await page.locator(".wx-srv-name-prompt-button").click();
  }
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

async function addCanvas(page: Page): Promise<void> {
  await page.locator(".wx-srv-more-button").click();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
  await page.locator(".wx-srv-more-canvas").click();
  await page.waitForTimeout(1500);
}

async function dump(page: Page, tag: string): Promise<void> {
  const info = await page.evaluate(() => {
    const canv = Array.from(document.querySelectorAll(".wx-srv-bubble-canvas")).map((el) => {
      const r = el.getBoundingClientRect();
      const s = el.querySelector(".wx-srv-canvas-surface")!.getBoundingClientRect();
      return { seq: el.getAttribute("data-message-seq"), cls: el.className, bubble: [r.x, r.y, r.width, r.height], surface: [s.x, s.y, s.width, s.height] };
    });
    const svgs = Array.from(document.querySelectorAll("svg.wx-srv-drawing")).map((el) => {
      const r = el.getBoundingClientRect();
      return { cls: el.getAttribute("class"), anchor: el.getAttribute("data-anchor-seq"), disp: (el as SVGElement).style.display, box: [r.x, r.y, r.width, r.height], vb: el.getAttribute("viewBox"), paths: el.querySelectorAll("path").length };
    });
    return { ua: navigator.userAgent, canv, svgs };
  });
  console.log(tag, JSON.stringify(info, null, 1));
  await page.screenshot({ path: test.info().outputPath(`${tag}.png`) });
}

async function draw(page: Page): Promise<void> {
  await page.locator(".wx-srv-pen-button").click();
  await expect(page.locator(".wx-srv-draw-surface")).toBeVisible();
  const canvas = page.locator(".wx-srv-bubble-canvas").last();
  const box = (await canvas.boundingBox())!;
  console.log("drawing over canvas box", JSON.stringify(box));
  const vp = page.viewportSize()!;
  const top = Math.max(box.y, 0) + 20;
  const bottom = Math.min(box.y + box.height, vp.height) - 20;
  const start = { x: box.x + 40, y: (top + bottom) / 2 };
  console.log("stroke start", JSON.stringify(start));
  if (process.env["REPRO_B"] === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    const t = async (type: string, x: number, y: number): Promise<void> => {
      await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
    };
    await t("touchStart", start.x, start.y);
    for (let i = 1; i <= 15; i++) {
      await t("touchMove", start.x + i * 10, start.y + Math.sin(i / 2) * 30);
      await page.waitForTimeout(16);
    }
    await page.screenshot({ path: test.info().outputPath("mid-stroke.png") });
    await t("touchEnd", 0, 0);
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) {
      await page.mouse.move(start.x + i * 10, start.y + Math.sin(i / 2) * 30);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  }
  await page.waitForTimeout(1500);
}

test("canvas visibility across engines", async ({ baseURL }) => {
  const engine = process.env["REPRO_B"] ?? "webkit";
  const chrome: Browser = await chromium.launch();
  const other: Browser = engine === "webkit" ? await webkit.launch() : await chromium.launch(process.env["REPRO_DARK"]?.startsWith("force") ? { args: ["--blink-settings=forceDarkModeEnabled=true"] } : {});
  const contextA = await chrome.newContext({ baseURL: baseURL!, viewport: { width: 1000, height: 900 } });
  const iphone = engine === "webkit"
    ? devices["iPhone 13"]
    : {
        viewport: { width: Number(process.env["REPRO_W"] ?? 384), height: Number(process.env["REPRO_H"] ?? 700) },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
        colorScheme: process.env["REPRO_DARK"] && process.env["REPRO_DARK"] !== "forcelight" ? ("dark" as const) : ("light" as const),
        userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
      };
  const contextB = await other.newContext({ ...iphone, baseURL: baseURL! });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  pageB.on("console", (m) => console.log("B console", m.type(), m.text()));
  pageB.on("pageerror", (e) => console.log("B pageerror", e.message));
  const seedN = Number(process.env["REPRO_SEED"] ?? 0);
  if (seedN > 0) {
    const r = await pageA.request.post("/test/server/seed-messages", {
      data: { count: seedN, spreadS: 1, startAgoS: 600, label: "hist", sender: "Fixture" },
    });
    expect(r.ok()).toBe(true);
  }
  await unlockServer(pageA, "Josh");
  await unlockServer(pageB, "Purdy");

  await addCanvas(pageA);
  await pageB.waitForTimeout(2500);
  await dump(pageA, "1-A-after-josh-canvas");
  await dump(pageB, "1-B-after-josh-canvas");

  await addCanvas(pageB);
  await pageB.waitForTimeout(1000);
  await dump(pageB, "2-B-after-purdy-canvas");
  await draw(pageB);
  await dump(pageB, "3-B-after-purdy-draws");
  await pageA.waitForTimeout(2000);
  await dump(pageA, "3-A-after-purdy-draws");

  await chrome.close();
  await other.close();
});
