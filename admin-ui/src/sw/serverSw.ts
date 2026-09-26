/** The opt-in Server notification worker.
 *
 * Notifications intentionally carry no push payload.  The worker only tells
 * the operator that there is generic activity, preserving the disguise when a
 * device is locked or another app is visible.
 */

const SERVER_PATH = "/admin/server";

function isFocusedServerClient(client: Client): client is WindowClient {
  if (client.type !== "window") return false;
  const windowClient = client as WindowClient;
  if (!windowClient.focused || windowClient.visibilityState !== "visible") return false;
  try {
    return new URL(windowClient.url).pathname.startsWith(SERVER_PATH);
  } catch {
    return false;
  }
}

const worker = self as unknown as ServiceWorkerGlobalScope;

export async function handlePush(target: ServiceWorkerGlobalScope): Promise<void> {
  // Inv 45/item 12: every push must end in showNotification, or Chrome can throttle/revoke this
  // origin's notification permission over time for violating userVisibleOnly. matchAll() failing
  // must not skip that call — fall back to "no known clients" (the safe, non-silent default) and
  // still show the notification.
  let clients: readonly Client[] = [];
  try {
    clients = await target.clients.matchAll({ type: "window", includeUncontrolled: true });
  } catch {
    // Fall through with the empty default.
  }
  const isFocused = clients.some(isFocusedServerClient);
  const options: NotificationOptions & { renotify: boolean; silent?: boolean } = {
    body: "New activity",
    tag: "wixy-server",
    renotify: !isFocused,
    ...(isFocused ? { silent: true } : {}),
  };
  await target.registration.showNotification("Server", options);
  const message = { type: "push-shown" };
  for (const client of clients) {
    if (typeof client.postMessage === "function") {
      client.postMessage(message);
    }
  }
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel("wx-server-push");
      channel.postMessage(message);
      channel.close();
    } catch {
      // Ignore broadcast errors
    }
  }
}

worker.addEventListener("push", (event: PushEvent) => {
  event.waitUntil(handlePush(worker));
});

export async function handleNotificationClick(target: ServiceWorkerGlobalScope): Promise<void> {
  const clients = await target.clients.matchAll({ type: "window", includeUncontrolled: true });
  const adminClient = clients.find(
    (client): client is WindowClient => {
      if (client.type !== "window") return false;
      try {
        return new URL(client.url).pathname.startsWith("/admin");
      } catch {
        return false;
      }
    },
  );
  if (adminClient !== undefined) {
    await adminClient.focus();
    try {
      await adminClient.navigate(SERVER_PATH);
      return;
    } catch {
      // A client opened before opt-in may not yet be controlled by this
      // worker. Open a controlled route rather than leaving the user on the
      // unrelated admin panel after the notification tap.
      await target.clients.openWindow(SERVER_PATH);
      return;
    }
  }
  await target.clients.openWindow(SERVER_PATH);
}

worker.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil(handleNotificationClick(worker));
});
