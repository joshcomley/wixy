/** Android-only opt-in Web Push control for the Server settings sheet. */

const CONFIG_PATH = "/api/admin/server/push/config";
const SUBSCRIPTION_PATH = "/api/admin/server/push/subscriptions";
const SERVICE_WORKER_PATH = "/admin/server-sw.js";

type PushState = "off" | "on" | "blocked" | "error";

interface NavigatorWithUserAgentData extends Navigator {
  readonly userAgentData?: { readonly platform?: string };
}

interface BrowserWindow extends Window {
  readonly Notification: typeof globalThis.Notification;
}

export interface PushToggleDeps {
  readonly deviceId: string;
  readonly sender: string;
  readonly win?: Window;
  readonly fetch?: typeof globalThis.fetch;
  readonly token?: string;
  readonly getToken?: () => string | null;
}

export interface PushToggle {
  readonly element: HTMLElement;
  teardown(): void;
}

export function isAndroidPushCapable(win?: Window): boolean {
  const browserWindow = win ?? (typeof window === "undefined" ? undefined : window);
  if (browserWindow === undefined) return false;
  const navigator = browserWindow.navigator as NavigatorWithUserAgentData;
  const isAndroid = navigator.userAgentData?.platform === "Android"
    || /Android/i.test(navigator.userAgent);
  return isAndroid
    && "PushManager" in browserWindow
    && "serviceWorker" in navigator
    && "Notification" in browserWindow;
}

export function mountPushToggle(host: HTMLElement, deps: PushToggleDeps): PushToggle {
  const browserWindow = (deps.win ?? window) as BrowserWindow;
  const request = deps.fetch ?? browserWindow.fetch.bind(browserWindow);
  const root = document.createElement("section");
  root.className = "wx-srv-push-toggle";
  const title = document.createElement("h3");
  title.textContent = "Notifications";
  const explanation = document.createElement("p");
  explanation.className = "wx-srv-push-explanation";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "wx-srv-push-button";
  button.setAttribute("role", "switch");
  root.append(title, explanation, button);
  host.appendChild(root);

  let state: PushState = "off";
  let busy = true;
  let publicKey: string | null = null;
  let registration: ServiceWorkerRegistration | null = null;
  let destroyed = false;

  function authHeaders(contentType = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (contentType) headers["Content-Type"] = "application/json";
    const token = deps.getToken?.() ?? deps.token;
    if (token) headers["X-Wixy-Server-Token"] = token;
    return headers;
  }

  function render(): void {
    root.dataset.state = state;
    button.disabled = busy || state === "blocked";
    button.setAttribute("aria-checked", String(state === "on"));
    if (state === "on") {
      button.textContent = "Disable notifications";
      explanation.textContent = "Notifications are enabled on this device.";
    } else if (state === "blocked") {
      button.textContent = "Notifications blocked";
      explanation.textContent = "Notifications are blocked in your browser. Allow them in site settings to enable alerts.";
    } else if (state === "error") {
      button.textContent = "Try again";
      explanation.textContent = "Notifications could not be set up. Try again.";
    } else {
      button.textContent = "Enable notifications";
      explanation.textContent = "Get a discreet alert when there is new Server activity.";
    }
  }

  async function responseOrThrow(response: Response): Promise<Response> {
    if (!response.ok) throw new Error(`push request failed (${response.status})`);
    return response;
  }

  async function loadState(): Promise<void> {
    try {
      const configResponse = await responseOrThrow(await request(CONFIG_PATH, {
        headers: authHeaders(),
      }));
      const config = (await configResponse.json()) as { publicKey?: unknown };
      if (typeof config.publicKey !== "string" || config.publicKey.length === 0) {
        throw new Error("invalid push configuration");
      }
      publicKey = config.publicKey;
      const statusResponse = await responseOrThrow(await request(
        `${SUBSCRIPTION_PATH}/${encodeURIComponent(deps.deviceId)}`,
        { headers: authHeaders() },
      ));
      const status = (await statusResponse.json()) as { subscribed?: unknown };
      state = status.subscribed === true ? "on" : "off";
    } catch {
      state = "error";
    } finally {
      busy = false;
      if (!destroyed) render();
    }
  }

  function decodePublicKey(value: string): Uint8Array<ArrayBuffer> {
    const binary = browserWindow.atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(
      (4 - value.length % 4) % 4,
    ));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  async function enable(): Promise<void> {
    busy = true;
    render();
    try {
      const permission = await browserWindow.Notification.requestPermission();
      if (permission === "denied") {
        state = "blocked";
        return;
      }
      if (permission !== "granted" || publicKey === null) throw new Error("push permission unavailable");
      registration = await browserWindow.navigator.serviceWorker.register(
        SERVICE_WORKER_PATH,
        { scope: "/admin/" },
      );
      const ready = await browserWindow.navigator.serviceWorker.ready;
      const subscription = await ready.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodePublicKey(publicKey),
      });
      const json = subscription.toJSON();
      const keys = json.keys;
      if (typeof json.endpoint !== "string" || keys === undefined
        || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
        throw new Error("invalid push subscription");
      }
      await responseOrThrow(await request(
        `${SUBSCRIPTION_PATH}/${encodeURIComponent(deps.deviceId)}`,
        {
          method: "PUT",
          headers: authHeaders(true),
          body: JSON.stringify({
            sender: deps.sender,
            subscription: { endpoint: json.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
          }),
        },
      ));
      state = "on";
    } catch {
      state = browserWindow.Notification.permission === "denied" ? "blocked" : "error";
    } finally {
      busy = false;
      if (!destroyed) render();
    }
  }

  async function disable(): Promise<void> {
    busy = true;
    render();
    try {
      const ready = registration ?? await browserWindow.navigator.serviceWorker.ready;
      const subscription = await ready.pushManager.getSubscription();
      if (subscription !== null) await subscription.unsubscribe();
      await responseOrThrow(await request(
        `${SUBSCRIPTION_PATH}/${encodeURIComponent(deps.deviceId)}`,
        { method: "DELETE", headers: authHeaders() },
      ));
      await ready.unregister();
      registration = null;
      state = "off";
    } catch {
      state = "error";
    } finally {
      busy = false;
      if (!destroyed) render();
    }
  }

  const onClick = (): void => {
    if (busy) return;
    if (state === "on") void disable();
    else if (state !== "blocked") void enable();
  };
  button.addEventListener("click", onClick);
  render();
  void loadState();

  return {
    element: root,
    teardown(): void {
      destroyed = true;
      button.removeEventListener("click", onClick);
      root.remove();
    },
  };
}
