import { expect, test, type Page } from "@playwright/test";

const MULTI_TAP_INTERVAL_MS = 400;
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36";

async function unlockServer(page: Page, name: string): Promise<void> {
  await page.goto("/admin/server");
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  const configResponse = await page.request.post("/test/server/config");
  const { pin } = (await configResponse.json()) as { pin: string };
  await page.locator(".wx-srv-panel").click();
  await expect(page.locator(".wx-srv-affordance")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
  await page.locator(".wx-srv-affordance").click();
  await expect(page.locator(".wx-srv-pinpad")).toBeVisible();
  for (const digit of pin) await page.locator(`.wx-srv-pinpad-key-digit:text-is("${digit}")`).click();
  await page.locator(".wx-srv-pinpad-key-submit").click();
  await expect(page.locator(".wx-srv-name-prompt")).toBeVisible();
  await page.locator(".wx-srv-name-prompt-input").fill(name);
  await page.locator(".wx-srv-name-prompt-button").click();
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

test.describe.configure({ timeout: 60_000 });

test("desktop browser does not show the optional push control", async ({ page }) => {
  await unlockServer(page, "Desktop tester");
  await page.locator(".wx-srv-settings-button").click();
  await expect(page.locator(".wx-srv-sheet")).toBeVisible();
  await expect(page.locator(".wx-srv-push-toggle")).toHaveCount(0);
  await expect(page.locator(".wx-srv-push-unsupported")).toBeVisible();
  await expect(page.locator(".wx-srv-push-unsupported")).toContainText("Android devices only");
});

test.describe("Android browser", () => {
  test.use({ userAgent: ANDROID_UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("mounts push controls and enables/disables the subscription through the sheet", async ({ page }) => {
    const pushRequests: Array<{ method: string; url: string }> = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/admin/server/push/")) {
        pushRequests.push({ method: request.method(), url: request.url() });
      }
    });
    await page.addInitScript(() => {
      const calls: string[] = [];
      Object.defineProperty(window, "__wxPushCalls", { configurable: true, value: calls });
      const subscription = {
        toJSON: () => ({
          endpoint: "https://fcm.googleapis.com/fcm/send/test-token",
          keys: { p256dh: "p256dh-test", auth: "auth-test" },
        }),
        unsubscribe: async () => { calls.push("unsubscribe"); return true; },
      };
      const registration = {
        pushManager: {
          subscribe: async () => { calls.push("subscribe"); return subscription; },
          getSubscription: async () => subscription,
        },
        unregister: async () => { calls.push("unregister"); return true; },
      };
      Object.defineProperty(window, "PushManager", { configurable: true, value: class PushManager {} });
      Object.defineProperty(window, "Notification", {
        configurable: true,
        value: {
          permission: "default",
          requestPermission: async () => { calls.push("permission"); return "granted"; },
        },
      });
      const listeners: Record<string, Function[]> = {};
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          register: async (path: string, options: { scope: string }) => {
            calls.push(`register:${path}:${options.scope}`);
            return registration;
          },
          ready: Promise.resolve(registration),
          addEventListener: (type: string, fn: Function) => {
            (listeners[type] ??= []).push(fn);
          },
          removeEventListener: (type: string, fn: Function) => {
            const list = listeners[type];
            if (list) {
              const idx = list.indexOf(fn);
              if (idx !== -1) list.splice(idx, 1);
            }
          },
        },
      });
    });

    await unlockServer(page, "Android tester");
    await page.locator(".wx-srv-settings-button").click();
    const toggle = page.locator(".wx-srv-push-toggle");
    await expect(toggle).toBeVisible();
    const button = toggle.getByRole("switch");
    await expect(button).toBeEnabled();
    const put = page.waitForResponse((response) =>
      response.url().includes("/api/admin/server/push/subscriptions/")
      && response.request().method() === "PUT",
    );
    await button.click();
    expect((await put).status()).toBe(204);
    await expect(button).toHaveText("Disable notifications");
    await expect.poll(() => page.evaluate(() => (window as Window & { __wxPushCalls?: string[] }).__wxPushCalls))
      .toEqual(["permission", `register:/admin/server-sw.js:/admin/`, "subscribe"]);

    const testButton = toggle.locator(".wx-srv-push-test-button");
    await expect(testButton).toBeVisible();
    await expect(testButton).toHaveText("Send me a test notification");

    const testReq = page.waitForResponse((response) =>
      response.url().includes("/api/admin/server/push/subscriptions/")
      && response.url().endsWith("/test")
      && response.request().method() === "POST",
    );
    await testButton.click();
    const testResp = await testReq;
    expect(testResp.status()).toBe(200);
    const testJson = (await testResp.json()) as { ok: boolean; statusCode: number };
    expect(testJson).toEqual({ ok: true, statusCode: 201 });

    // Simulate confirmation event broadcast by the service worker upon showing the notification
    await page.evaluate(() => {
      const bc = new BroadcastChannel("wx-server-push");
      bc.postMessage({ type: "push-shown" });
      bc.close();
    });

    const testStatus = toggle.locator(".wx-srv-push-test-status");
    await expect(testStatus).toBeVisible();
    await expect(toggle.locator(".wx-srv-push-test-message")).toHaveText("Your phone received the test and showed it.");
    await expect(toggle.locator(".wx-srv-push-test-hint")).toContainText("Android Settings -> Apps -> Chrome -> Notifications is On");

    await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
    const del = page.waitForResponse((response) =>
      response.url().includes("/api/admin/server/push/subscriptions/")
      && response.request().method() === "DELETE",
      { timeout: 10_000 },
    );
    await button.click();
    expect((await del).status()).toBe(204);
    await expect(button).toHaveText("Enable notifications");
    await expect(testButton).toBeHidden();
    await expect(testStatus).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as Window & { __wxPushCalls?: string[] }).__wxPushCalls))
      .toEqual(["permission", `register:/admin/server-sw.js:/admin/`, "subscribe", "unsubscribe", "unregister"]);
    expect(pushRequests.map((request) => request.method)).toContain("PUT");
    expect(pushRequests.map((request) => request.method)).toContain("POST");
    expect(pushRequests.map((request) => request.method)).toContain("DELETE");

    const worker = await page.request.get("/admin/server-sw.js");
    expect(worker.ok()).toBe(true);
    expect(worker.headers()["service-worker-allowed"]).toBe("/admin/");
    expect(worker.headers()["content-type"]).toContain("javascript");
  });

  test("derives honest state when browser has no subscription and repairs it", async ({ page }) => {
    await page.addInitScript(() => {
      const calls: string[] = [];
      Object.defineProperty(window, "__wxPushCalls", { configurable: true, value: calls });
      let currentSub: unknown = null;
      const subscription = {
        toJSON: () => ({
          endpoint: "https://fcm.googleapis.com/fcm/send/repair-test-token",
          keys: { p256dh: "p256dh-test", auth: "auth-test" },
        }),
        unsubscribe: async () => { calls.push("unsubscribe"); currentSub = null; return true; },
      };
      const registration = {
        pushManager: {
          subscribe: async () => { calls.push("subscribe"); currentSub = subscription; return subscription; },
          getSubscription: async () => currentSub,
        },
        unregister: async () => { calls.push("unregister"); return true; },
      };
      Object.defineProperty(window, "__setPushSub", {
        configurable: true,
        value: (hasSub: boolean) => { currentSub = hasSub ? subscription : null; },
      });
      Object.defineProperty(window, "PushManager", { configurable: true, value: class PushManager {} });
      Object.defineProperty(window, "Notification", {
        configurable: true,
        value: {
          permission: "granted",
          requestPermission: async () => { calls.push("permission"); return "granted"; },
        },
      });
      const listeners: Record<string, Function[]> = {};
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          register: async (path: string, options: { scope: string }) => {
            calls.push(`register:${path}:${options.scope}`);
            return registration;
          },
          ready: Promise.resolve(registration),
          getRegistration: async () => registration,
          addEventListener: (type: string, fn: Function) => {
            (listeners[type] ??= []).push(fn);
          },
          removeEventListener: (type: string, fn: Function) => {
            const list = listeners[type];
            if (list) {
              const idx = list.indexOf(fn);
              if (idx !== -1) list.splice(idx, 1);
            }
          },
        },
      });
    });

    await unlockServer(page, "Honest repair tester");
    await page.locator(".wx-srv-settings-button").click();
    const toggle = page.locator(".wx-srv-push-toggle");
    await expect(toggle).toBeVisible();
    const button = toggle.getByRole("switch");

    // Enable notifications: sets subscription on client and server
    const put = page.waitForResponse((response) =>
      response.url().includes("/api/admin/server/push/subscriptions/")
      && response.request().method() === "PUT",
    );
    await button.click();
    expect((await put).status()).toBe(204);
    await expect(button).toHaveText("Disable notifications");

    // Close settings sheet
    await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
    await page.locator(".wx-srv-sheet-close").click();
    await expect(page.locator(".wx-srv-sheet")).toBeHidden();

    // Simulate browser dropping the subscription while server still has it
    await page.evaluate(() => {
      (window as Window & { __setPushSub?: (val: boolean) => void }).__setPushSub?.(false);
    });

    // Wait past multi-tap window so reopening is not treated as panic tap
    await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);

    // Reopen settings sheet: honest state derivation detects missing subscription
    await page.locator(".wx-srv-settings-button").click();
    await expect(page.locator(".wx-srv-sheet")).toBeVisible();
    await expect(toggle).toHaveAttribute("data-state", "needs_re-enabling");
    await expect(button).toHaveText("Re-enable notifications");
    await expect(toggle.locator(".wx-srv-push-explanation")).toHaveText("Notifications need to be re-enabled on this device.");

    // One-tap repair: clicking Re-enable notifications repairs subscription
    const repairPut = page.waitForResponse((response) =>
      response.url().includes("/api/admin/server/push/subscriptions/")
      && response.request().method() === "PUT",
    );
    await button.click();
    expect((await repairPut).status()).toBe(204);
    await expect(toggle).toHaveAttribute("data-state", "on");
    await expect(button).toHaveText("Disable notifications");
  });
});
