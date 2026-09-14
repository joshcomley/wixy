import { describe, expect, it, vi } from "vitest";

type FakeTarget = {
  clients: {
    matchAll: ReturnType<typeof vi.fn>;
    openWindow: ReturnType<typeof vi.fn>;
  };
  registration: { showNotification: ReturnType<typeof vi.fn> };
};

function targetWith(clients: unknown[]): FakeTarget {
  return {
    clients: {
      matchAll: vi.fn(async () => clients),
      openWindow: vi.fn(async () => null),
    },
    registration: { showNotification: vi.fn(async () => undefined) },
  };
}

describe("Server service worker", () => {
  it("shows only the fixed generic notification when the chat is not focused", async () => {
    const target = targetWith([
      { type: "window", url: "https://example.test/admin/pages", focused: true, visibilityState: "visible" },
    ]);
    const { handlePush } = await import("../src/sw/serverSw");

    await handlePush(target as unknown as ServiceWorkerGlobalScope);

    expect(target.registration.showNotification).toHaveBeenCalledWith("Server", {
      body: "New activity",
      tag: "wixy-server",
      renotify: true,
    });
  });

  it("does not notify while a visible focused Server page is open", async () => {
    const target = targetWith([
      { type: "window", url: "https://example.test/admin/server/thread", focused: true, visibilityState: "visible" },
    ]);
    const { handlePush } = await import("../src/sw/serverSw");

    await handlePush(target as unknown as ServiceWorkerGlobalScope);

    expect(target.registration.showNotification).not.toHaveBeenCalled();
  });

  it("focuses an existing admin window and navigates it to Server", async () => {
    const adminClient = {
      type: "window",
      url: "https://example.test/admin/pages",
      focus: vi.fn(async () => adminClient),
      navigate: vi.fn(async () => adminClient),
    };
    const target = targetWith([adminClient]);
    const { handleNotificationClick } = await import("../src/sw/serverSw");

    await handleNotificationClick(target as unknown as ServiceWorkerGlobalScope);

    expect(adminClient.focus).toHaveBeenCalledOnce();
    expect(adminClient.navigate).toHaveBeenCalledWith("/admin/server");
    expect(target.clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens Server when there is no existing admin window", async () => {
    const target = targetWith([]);
    const { handleNotificationClick } = await import("../src/sw/serverSw");

    await handleNotificationClick(target as unknown as ServiceWorkerGlobalScope);

    expect(target.clients.openWindow).toHaveBeenCalledWith("/admin/server");
  });

  it("registers no fetch handler", async () => {
    vi.resetModules();
    const events: string[] = [];
    const browserWindow = (globalThis as unknown as {
      window: { addEventListener: typeof globalThis.addEventListener };
    }).window;
    const originalAddEventListener = browserWindow.addEventListener.bind(browserWindow);
    const addEventListener = vi.spyOn(browserWindow, "addEventListener").mockImplementation((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      events.push(type);
      return originalAddEventListener(type, listener, options);
    });

    await import("../src/sw/serverSw");

    expect(events).toContain("push");
    expect(events).toContain("notificationclick");
    expect(events).not.toContain("fetch");
    addEventListener.mockRestore();
  });
});
