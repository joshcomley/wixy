import { beforeEach, describe, expect, it, vi } from "vitest";

import { isAndroidPushCapable, mountPushToggle } from "../src/server/pushToggle";

function installPushBrowser(): void {
  Object.defineProperty(window, "PushManager", { configurable: true, value: class PushManager {} });
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: { permission: "default", requestPermission: vi.fn(async () => "granted") },
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: vi.fn(), ready: Promise.resolve({}) },
  });
}

describe("Server push toggle", () => {
  beforeEach(() => {
    installPushBrowser();
  });

  it("only reports capability for Android browsers with push support", () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0" });
    expect(isAndroidPushCapable(window)).toBe(false);
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 Android 14" });
    expect(isAndroidPushCapable(window)).toBe(true);
  });

  it("enables with the click gesture and disables in reverse order", async () => {
    const subscribe = vi.fn(async () => subscription);
    const getSubscription = vi.fn(async () => subscription);
    const unregister = vi.fn(async () => true);
    const register = vi.fn(async () => registration);
    const registration = {
      pushManager: { subscribe, getSubscription },
      unregister,
    };
    const subscription = {
      toJSON: () => ({
        endpoint: "https://fcm.googleapis.com/fcm/send/token",
        keys: { p256dh: "public", auth: "secret" },
      }),
      unsubscribe: vi.fn(async () => true),
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register, ready: Promise.resolve(registration) },
    });
    const requests: RequestInit[] = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      const url = String(input);
      if (init?.method === "PUT") return new Response(null, { status: 204 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.endsWith("/config")) return Response.json({ publicKey: "AQ" });
      return Response.json({ subscribed: false });
    });
    const host = document.createElement("div");
    const toggle = mountPushToggle(host, {
      deviceId: "device-123456",
      sender: "Alice",
      fetch: request as typeof globalThis.fetch,
    });
    const button = host.querySelector("button") as HTMLButtonElement;
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    button.click();
    await vi.waitFor(() => expect(button.textContent).toBe("Disable notifications"));
    expect(register).toHaveBeenCalledWith("/admin/server-sw.js", { scope: "/admin/" });
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.any(Uint8Array),
    });
    expect(JSON.parse(requests.find((init) => init.method === "PUT")?.body as string)).toMatchObject({
      sender: "Alice",
    });

    button.click();
    await vi.waitFor(() => expect(button.textContent).toBe("Enable notifications"));
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect(requests.some((init) => init.method === "DELETE")).toBe(true);
    toggle.teardown();
  });
});
