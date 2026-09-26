import { beforeEach, describe, expect, it, vi } from "vitest";

import { isAndroidPushCapable, mountPushToggle } from "../src/server/pushToggle";

function installPushBrowser(): void {
  const swListeners: Record<string, Set<(event: Event) => void>> = {};
  const swTarget = {
    addEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
      (swListeners[type] ??= new Set()).add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
      swListeners[type]?.delete(listener);
    }),
    dispatchEvent: vi.fn((event: Event) => {
      swListeners[event.type]?.forEach((listener) => listener(event));
      return true;
    }),
    register: vi.fn(),
    getRegistration: vi.fn(async () => undefined),
    ready: Promise.resolve({}),
  };
  Object.defineProperty(window, "PushManager", { configurable: true, value: class PushManager {} });
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: { permission: "default", requestPermission: vi.fn(async () => "granted") },
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: swTarget,
  });
}

describe("Server push toggle", () => {
  beforeEach(() => {
    installPushBrowser();
    vi.restoreAllMocks();
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
      scope: "/admin/",
      pushManager: { subscribe, getSubscription },
      unregister,
    };
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/token",
      toJSON: () => ({
        endpoint: "https://fcm.googleapis.com/fcm/send/token",
        keys: { p256dh: "public", auth: "secret" },
      }),
      unsubscribe: vi.fn(async () => true),
    };
    const sw = navigator.serviceWorker as unknown as { register: unknown; ready: unknown; getRegistration: unknown };
    sw.register = register;
    sw.ready = Promise.resolve(registration);
    sw.getRegistration = vi.fn(async () => registration);

    const requests: RequestInit[] = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      const url = String(input);
      if (init?.method === "PUT") return new Response(null, { status: 204 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.endsWith("/config")) return Response.json({ publicKey: "AQ" });
      return Response.json({ subscribed: false, endpoint: null });
    });
    const host = document.createElement("div");
    const toggle = mountPushToggle(host, {
      deviceId: "device-123456",
      sender: "Alice",
      fetch: request as typeof globalThis.fetch,
    });
    const button = host.querySelector(".wx-srv-push-button") as HTMLButtonElement;
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

  describe("Honest state derivation", () => {
    it("shows 'needs re-enabling' when server says subscribed but browser permission is not granted, and repairs on click", async () => {
      Object.defineProperty(window.Notification, "permission", { configurable: true, value: "default" });
      const requestPermission = vi.fn(async () => "granted");
      Object.defineProperty(window.Notification, "requestPermission", { configurable: true, value: requestPermission });

      const subscribe = vi.fn(async () => subscription);
      const getSubscription = vi.fn(async () => subscription);
      const register = vi.fn(async () => registration);
      const registration = {
        scope: "/admin/",
        pushManager: { subscribe, getSubscription },
        unregister: vi.fn(async () => true),
      };
      const subscription = {
        endpoint: "https://fcm.googleapis.com/fcm/send/token",
        toJSON: () => ({
          endpoint: "https://fcm.googleapis.com/fcm/send/token",
          keys: { p256dh: "pub", auth: "sec" },
        }),
        unsubscribe: vi.fn(async () => true),
      };
      const sw = navigator.serviceWorker as unknown as { register: unknown; ready: unknown; getRegistration: unknown };
      sw.register = register;
      sw.ready = Promise.resolve(registration);
      sw.getRegistration = vi.fn(async () => registration);

      const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "PUT") return new Response(null, { status: 204 });
        if (url.endsWith("/config")) return Response.json({ publicKey: "AQ" });
        return Response.json({ subscribed: true, endpoint: "https://fcm.googleapis.com/fcm/send/token" });
      });

      const host = document.createElement("div");
      const toggle = mountPushToggle(host, {
        deviceId: "device-123456",
        sender: "Alice",
        fetch: request as typeof globalThis.fetch,
      });

      const button = host.querySelector(".wx-srv-push-button") as HTMLButtonElement;
      const explanation = host.querySelector(".wx-srv-push-explanation") as HTMLElement;
      const testButton = host.querySelector(".wx-srv-push-test-button") as HTMLButtonElement;

      await vi.waitFor(() => expect(button.textContent).toBe("Re-enable notifications"));
      expect(explanation.textContent).toBe("Notifications need to be re-enabled on this device.");
      expect(testButton.hidden).toBe(true);

      // One tap repairs it
      button.click();
      await vi.waitFor(() => expect(button.textContent).toBe("Disable notifications"));
      expect(requestPermission).toHaveBeenCalledOnce();
      expect(register).toHaveBeenCalledOnce();
      expect(subscribe).toHaveBeenCalledOnce();
      expect(testButton.hidden).toBe(false);

      toggle.teardown();
    });

    it("shows 'needs re-enabling' when server says subscribed but browser has no SW registration", async () => {
      Object.defineProperty(window.Notification, "permission", { configurable: true, value: "granted" });
      const sw = navigator.serviceWorker as unknown as { getRegistration: unknown };
      sw.getRegistration = vi.fn(async () => undefined);

      const request = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/config")) return Response.json({ publicKey: "AQ" });
        return Response.json({ subscribed: true, endpoint: "https://fcm.googleapis.com/fcm/send/token" });
      });

      const host = document.createElement("div");
      const toggle = mountPushToggle(host, {
        deviceId: "device-123456",
        sender: "Alice",
        fetch: request as typeof globalThis.fetch,
      });

      const button = host.querySelector(".wx-srv-push-button") as HTMLButtonElement;
      await vi.waitFor(() => expect(button.textContent).toBe("Re-enable notifications"));
      toggle.teardown();
    });

    it("shows 'needs re-enabling' when server says subscribed but browser subscription endpoint differs", async () => {
      Object.defineProperty(window.Notification, "permission", { configurable: true, value: "granted" });
      const registration = {
        scope: "/admin/",
        pushManager: {
          getSubscription: vi.fn(async () => ({
            endpoint: "https://fcm.googleapis.com/fcm/send/different-token",
          })),
        },
      };
      const sw = navigator.serviceWorker as unknown as { getRegistration: unknown };
      sw.getRegistration = vi.fn(async () => registration);

      const request = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/config")) return Response.json({ publicKey: "AQ" });
        return Response.json({ subscribed: true, endpoint: "https://fcm.googleapis.com/fcm/send/server-token" });
      });

      const host = document.createElement("div");
      const toggle = mountPushToggle(host, {
        deviceId: "device-123456",
        sender: "Alice",
        fetch: request as typeof globalThis.fetch,
      });

      const button = host.querySelector(".wx-srv-push-button") as HTMLButtonElement;
      await vi.waitFor(() => expect(button.textContent).toBe("Re-enable notifications"));
      toggle.teardown();
    });

    it("shows 'blocked' when Notification.permission is denied", async () => {
      Object.defineProperty(window.Notification, "permission", { configurable: true, value: "denied" });

      const request = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/config")) return Response.json({ publicKey: "AQ" });
        return Response.json({ subscribed: true, endpoint: "https://fcm.googleapis.com/fcm/send/token" });
      });

      const host = document.createElement("div");
      const toggle = mountPushToggle(host, {
        deviceId: "device-123456",
        sender: "Alice",
        fetch: request as typeof globalThis.fetch,
      });

      const button = host.querySelector(".wx-srv-push-button") as HTMLButtonElement;
      const explanation = host.querySelector(".wx-srv-push-explanation") as HTMLElement;
      await vi.waitFor(() => expect(button.textContent).toBe("Notifications blocked"));
      expect(button.disabled).toBe(true);
      expect(explanation.textContent).toContain("Notifications are blocked in your browser");
      toggle.teardown();
    });

    it("shows 'on' and reveals test button when server and browser are both healthy", async () => {
      Object.defineProperty(window.Notification, "permission", { configurable: true, value: "granted" });
      const registration = {
        scope: "/admin/",
        pushManager: {
          getSubscription: vi.fn(async () => ({
            endpoint: "https://fcm.googleapis.com/fcm/send/matching-token",
          })),
        },
      };
      const sw = navigator.serviceWorker as unknown as { getRegistration: unknown };
      sw.getRegistration = vi.fn(async () => registration);

      const request = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/config")) return Response.json({ publicKey: "AQ" });
        return Response.json({ subscribed: true, endpoint: "https://fcm.googleapis.com/fcm/send/matching-token" });
      });

      const host = document.createElement("div");
      const toggle = mountPushToggle(host, {
        deviceId: "device-123456",
        sender: "Alice",
        fetch: request as typeof globalThis.fetch,
      });

      const button = host.querySelector(".wx-srv-push-button") as HTMLButtonElement;
      const testButton = host.querySelector(".wx-srv-push-test-button") as HTMLButtonElement;
      await vi.waitFor(() => expect(button.textContent).toBe("Disable notifications"));
      expect(testButton.hidden).toBe(false);
      toggle.teardown();
    });
  });

  describe("Test notification flow", () => {
    async function mountHealthyOn(): Promise<{
      host: HTMLElement;
      testButton: HTMLButtonElement;
      testStatus: HTMLElement;
      toggle: ReturnType<typeof mountPushToggle>;
      request: ReturnType<typeof vi.fn>;
    }> {
      Object.defineProperty(window.Notification, "permission", { configurable: true, value: "granted" });
      const registration = {
        scope: "/admin/",
        pushManager: {
          getSubscription: vi.fn(async () => ({
            endpoint: "https://fcm.googleapis.com/fcm/send/token",
          })),
        },
      };
      const sw = navigator.serviceWorker as unknown as { getRegistration: unknown };
      sw.getRegistration = vi.fn(async () => registration);

      const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/test") && init?.method === "POST") {
          return Response.json({ ok: true, statusCode: 201 });
        }
        if (url.endsWith("/config")) return Response.json({ publicKey: "AQ" });
        return Response.json({ subscribed: true, endpoint: "https://fcm.googleapis.com/fcm/send/token" });
      });

      const host = document.createElement("div");
      const toggle = mountPushToggle(host, {
        deviceId: "device-123456",
        sender: "Alice",
        fetch: request as typeof globalThis.fetch,
      });
      const testButton = host.querySelector(".wx-srv-push-test-button") as HTMLButtonElement;
      const testStatus = host.querySelector(".wx-srv-push-test-status") as HTMLElement;
      await vi.waitFor(() => expect(testButton.hidden).toBe(false));

      return { host, testButton, testStatus, toggle, request };
    }

    it("confirms test notification when service worker confirms push was shown", async () => {
      const { testButton, testStatus, toggle, request } = await mountHealthyOn();

      testButton.click();
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
        expect.stringContaining("/subscriptions/device-123456/test"),
        expect.objectContaining({ method: "POST" }),
      ));

      // Simulate service worker sending push-shown message
      navigator.serviceWorker.dispatchEvent(new MessageEvent("message", {
        data: { type: "push-shown" },
      }));

      await vi.waitFor(() =>
        expect(testStatus.textContent).toContain("Your phone received the test and showed it.")
      );
      expect(testStatus.textContent).toContain("Chrome -> Settings -> Site settings -> Notifications must allow this site");
      expect(testButton.disabled).toBe(false);
      toggle.teardown();
    });

    it("shows timeout message with troubleshooting hints when confirmation does not arrive within 10s", async () => {
      vi.useFakeTimers();
      const { testButton, testStatus, toggle } = await mountHealthyOn();

      testButton.click();
      await vi.advanceTimersByTimeAsync(100);
      expect(testStatus.textContent).toContain("Google accepted it. Waiting for phone confirmation");

      await vi.advanceTimersByTimeAsync(10_000);

      expect(testStatus.textContent).toContain(
        "Google accepted it but your phone did not confirm within ~10 seconds."
      );
      expect(testStatus.textContent).toContain("Android Settings -> Apps -> Chrome -> Notifications is On");
      expect(testStatus.textContent).toContain("battery saver");
      expect(testButton.disabled).toBe(false);

      toggle.teardown();
      vi.useRealTimers();
    });

    it("displays error when push service rejects the test request", async () => {
      const { testButton, testStatus, toggle, request } = await mountHealthyOn();
      request.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/test") && init?.method === "POST") {
          return Response.json({ ok: false, statusCode: 410 });
        }
        if (url.endsWith("/config")) return Response.json({ publicKey: "AQ" });
        return Response.json({ subscribed: true, endpoint: "https://fcm.googleapis.com/fcm/send/token" });
      });

      testButton.click();
      await vi.waitFor(() =>
        expect(testStatus.textContent).toContain("The push service rejected it (status 410).")
      );
      expect(testButton.disabled).toBe(false);
      toggle.teardown();
    });

    it("displays friendly message when rate limited", async () => {
      const { testButton, testStatus, toggle, request } = await mountHealthyOn();
      request.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/test") && init?.method === "POST") {
          return new Response(JSON.stringify({ error: "rate_limited", retryAfterS: 5 }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/config")) return Response.json({ publicKey: "AQ" });
        return Response.json({ subscribed: true, endpoint: "https://fcm.googleapis.com/fcm/send/token" });
      });

      testButton.click();
      await vi.waitFor(() =>
        expect(testStatus.textContent).toContain("Please wait a few seconds before requesting another test notification.")
      );
      expect(testButton.disabled).toBe(false);
      toggle.teardown();
    });
  });
});
