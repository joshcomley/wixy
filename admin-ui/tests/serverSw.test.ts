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
  it("shows one of a small set of generic notification bodies when the chat is not focused", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const target = targetWith([
      { type: "window", url: "https://example.test/admin/pages", focused: true, visibilityState: "visible" },
    ]);
    const { handlePush, NOTIFICATION_BODIES } = await import("../src/sw/serverSw");

    await handlePush(target as unknown as ServiceWorkerGlobalScope);

    expect(target.registration.showNotification).toHaveBeenCalledWith("Server", {
      body: NOTIFICATION_BODIES[0],
      tag: "wixy-server",
      renotify: true,
    });
    vi.restoreAllMocks();
  });

  it("varies the notification body across calls, so repeated identical pushes (real or test) don't trip Chrome's low-quality/spam-notification detector (operator report, round 2)", async () => {
    const { handlePush, NOTIFICATION_BODIES } = await import("../src/sw/serverSw");
    const seenBodies = new Set<string>();

    for (let i = 0; i < 50; i++) {
      const target = targetWith([]);
      // eslint-disable-next-line no-await-in-loop
      await handlePush(target as unknown as ServiceWorkerGlobalScope);
      const call = target.registration.showNotification.mock.calls[0]?.[1] as { body: string } | undefined;
      if (call) seenBodies.add(call.body);
    }

    expect(seenBodies.size).toBeGreaterThan(1);
    for (const body of seenBodies) {
      expect(NOTIFICATION_BODIES).toContain(body);
    }
  });

  it("broadcasts push-shown to clients and BroadcastChannel after showNotification resolves", async () => {
    const postMessage = vi.fn();
    const target = targetWith([
      { type: "window", url: "https://example.test/admin/server", focused: false, visibilityState: "hidden", postMessage },
    ]);
    const broadcastPostMessage = vi.fn();
    const broadcastClose = vi.fn();
    class MockBroadcastChannel {
      constructor(public name: string) {}
      postMessage = broadcastPostMessage;
      close = broadcastClose;
    }
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);

    const { handlePush } = await import("../src/sw/serverSw");
    await handlePush(target as unknown as ServiceWorkerGlobalScope);

    expect(postMessage).toHaveBeenCalledWith({ type: "push-shown" });
    expect(broadcastPostMessage).toHaveBeenCalledWith({ type: "push-shown" });
    expect(broadcastClose).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("notifies silently while a visible focused Server page is open to satisfy userVisibleOnly", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const target = targetWith([
      { type: "window", url: "https://example.test/admin/server/thread", focused: true, visibilityState: "visible" },
    ]);
    const { handlePush, NOTIFICATION_BODIES } = await import("../src/sw/serverSw");

    await handlePush(target as unknown as ServiceWorkerGlobalScope);

    expect(target.registration.showNotification).toHaveBeenCalledWith("Server", {
      body: NOTIFICATION_BODIES[0],
      tag: "wixy-server",
      renotify: false,
      silent: true,
    });
    vi.restoreAllMocks();
  });

  it("still shows the generic notification when clients.matchAll fails (Inv 45's userVisibleOnly guarantee must hold even on an unexpected error)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const showNotification = vi.fn(async () => undefined);
    const target = {
      clients: { matchAll: vi.fn(async () => { throw new Error("boom"); }), openWindow: vi.fn(async () => null) },
      registration: { showNotification },
    };
    const { handlePush, NOTIFICATION_BODIES } = await import("../src/sw/serverSw");

    await handlePush(target as unknown as ServiceWorkerGlobalScope);

    expect(showNotification).toHaveBeenCalledWith("Server", {
      body: NOTIFICATION_BODIES[0],
      tag: "wixy-server",
      renotify: true,
    });
    vi.restoreAllMocks();
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

  it("opens a new Server window when an uncontrolled admin window rejects navigation", async () => {
    const adminClient = {
      type: "window",
      url: "https://example.test/admin/pages",
      focus: vi.fn(async () => adminClient),
      navigate: vi.fn(async () => {
        throw new TypeError("client is not controlled");
      }),
    };
    const target = targetWith([adminClient]);
    const { handleNotificationClick } = await import("../src/sw/serverSw");

    await handleNotificationClick(target as unknown as ServiceWorkerGlobalScope);

    expect(adminClient.focus).toHaveBeenCalledOnce();
    expect(adminClient.navigate).toHaveBeenCalledWith("/admin/server");
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
