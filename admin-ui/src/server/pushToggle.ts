/** Android-only opt-in Web Push control for the Server settings sheet. */

const CONFIG_PATH = "/api/admin/server/push/config";
const SUBSCRIPTION_PATH = "/api/admin/server/push/subscriptions";
const SERVICE_WORKER_PATH = "/admin/server-sw.js";

type PushState = "off" | "on" | "needs_re-enabling" | "blocked" | "error";

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

export function mountUnsupportedPushNotice(host: HTMLElement, win?: Window): PushToggle {
  const browserWindow = win ?? (typeof window === "undefined" ? undefined : window);
  const navigator = browserWindow?.navigator as NavigatorWithUserAgentData | undefined;
  const isAndroid = navigator?.userAgentData?.platform === "Android"
    || (navigator?.userAgent !== undefined && /Android/i.test(navigator.userAgent));

  const root = document.createElement("section");
  root.className = "wx-srv-push-unsupported";
  const title = document.createElement("h3");
  title.textContent = "Notifications";
  const explanation = document.createElement("p");
  explanation.className = "wx-srv-push-explanation";
  explanation.textContent = isAndroid
    ? "Notifications are not supported by this browser."
    : "Notifications are currently supported on Android devices only.";
  root.append(title, explanation);
  host.appendChild(root);

  return {
    element: root,
    teardown(): void {
      root.remove();
    },
  };
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

  const testButton = document.createElement("button");
  testButton.type = "button";
  testButton.className = "wx-srv-push-test-button";
  testButton.textContent = "Send me a test notification";
  testButton.hidden = true;

  const testStatus = document.createElement("div");
  testStatus.className = "wx-srv-push-test-status";
  testStatus.setAttribute("role", "status");
  testStatus.hidden = true;

  root.append(title, explanation, button, testButton, testStatus);
  host.appendChild(root);

  let state: PushState = "off";
  let busy = true;
  let testBusy = false;
  let publicKey: string | null = null;
  let registration: ServiceWorkerRegistration | null = null;
  let destroyed = false;

  let testTimeoutId: number | null = null;
  let testChannel: BroadcastChannel | null = null;
  let testSwListener: ((event: MessageEvent) => void) | null = null;

  function authHeaders(contentType = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (contentType) headers["Content-Type"] = "application/json";
    const token = deps.getToken?.() ?? deps.token;
    if (token) headers["X-Wixy-Server-Token"] = token;
    return headers;
  }

  function cleanupTest(): void {
    if (testTimeoutId !== null) {
      browserWindow.clearTimeout(testTimeoutId);
      testTimeoutId = null;
    }
    if (testChannel !== null) {
      try {
        testChannel.close();
      } catch {
        // Ignore
      }
      testChannel = null;
    }
    if (testSwListener !== null) {
      try {
        browserWindow.navigator.serviceWorker.removeEventListener("message", testSwListener);
      } catch {
        // Ignore
      }
      testSwListener = null;
    }
  }

  function render(): void {
    root.dataset.state = state;
    button.disabled = busy || state === "blocked";
    button.setAttribute("aria-checked", String(state === "on"));

    if (state === "on") {
      button.textContent = "Disable notifications";
      explanation.textContent = "Notifications are enabled on this device.";
      testButton.hidden = false;
    } else if (state === "needs_re-enabling") {
      button.textContent = "Re-enable notifications";
      explanation.textContent = "Notifications need to be re-enabled on this device.";
      testButton.hidden = true;
      testStatus.hidden = true;
      testStatus.textContent = "";
    } else if (state === "blocked") {
      button.textContent = "Notifications blocked";
      explanation.textContent = "Notifications are blocked in your browser. Allow them in site settings to enable alerts.";
      testButton.hidden = true;
      testStatus.hidden = true;
      testStatus.textContent = "";
    } else if (state === "error") {
      button.textContent = "Try again";
      explanation.textContent = "Notifications could not be set up. Try again.";
      testButton.hidden = true;
      testStatus.hidden = true;
      testStatus.textContent = "";
    } else {
      button.textContent = "Enable notifications";
      explanation.textContent = "Get a discreet alert when there is new Server activity.";
      testButton.hidden = true;
      testStatus.hidden = true;
      testStatus.textContent = "";
    }
  }

  async function responseOrThrow(response: Response): Promise<Response> {
    if (!response.ok) throw new Error(`push request failed (${response.status})`);
    return response;
  }

  async function loadState(): Promise<void> {
    try {
      if (browserWindow.Notification.permission === "denied") {
        state = "blocked";
        return;
      }
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
      const status = (await statusResponse.json()) as { subscribed?: unknown; endpoint?: unknown };
      if (status.subscribed !== true) {
        state = "off";
        return;
      }

      // Server reports subscribed: verify browser state honestly
      if (browserWindow.Notification.permission !== "granted") {
        state = "needs_re-enabling";
        return;
      }

      let reg: ServiceWorkerRegistration | undefined = undefined;
      if (typeof browserWindow.navigator.serviceWorker.getRegistration === "function") {
        reg = await browserWindow.navigator.serviceWorker.getRegistration("/admin/");
      } else if (typeof browserWindow.navigator.serviceWorker.getRegistrations === "function") {
        const regs = await browserWindow.navigator.serviceWorker.getRegistrations();
        reg = regs.find((r) => r.scope.endsWith("/admin/"));
      } else if ("ready" in browserWindow.navigator.serviceWorker) {
        reg = await browserWindow.navigator.serviceWorker.ready;
      }

      if (!reg) {
        state = "needs_re-enabling";
        return;
      }

      const subscription = await reg.pushManager.getSubscription();
      if (!subscription || typeof status.endpoint !== "string" || subscription.endpoint !== status.endpoint) {
        state = "needs_re-enabling";
        return;
      }

      registration = reg;
      state = "on";
    } catch {
      state = browserWindow.Notification.permission === "denied" ? "blocked" : "error";
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
    cleanupTest();
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

  function renderTestResult(
    kind: "confirmed" | "timeout" | "rejected" | "rate_limited" | "not_subscribed" | "error",
    statusCode?: number,
  ): void {
    testStatus.hidden = false;
    testStatus.textContent = "";
    const msg = document.createElement("p");
    msg.className = "wx-srv-push-test-message";

    if (kind === "confirmed") {
      msg.textContent = "Your phone received the test and showed it.";
      testStatus.appendChild(msg);

      const hint = document.createElement("p");
      hint.className = "wx-srv-push-test-hint";
      hint.textContent = "If you did not see it appear, check: Android Settings -> Apps -> Chrome -> Notifications is On; Chrome -> Settings -> Site settings -> Notifications must allow this site; battery saver / \"restrict background\" can delay or drop them.";
      testStatus.appendChild(hint);
    } else if (kind === "timeout") {
      msg.textContent = "Google accepted it but your phone did not confirm within ~10 seconds.";
      testStatus.appendChild(msg);

      const hint = document.createElement("p");
      hint.className = "wx-srv-push-test-hint";
      hint.textContent = "Check: Android Settings -> Apps -> Chrome -> Notifications is On; Chrome -> Settings -> Site settings -> Notifications must allow this site; battery saver / \"restrict background\" can delay or drop them.";
      testStatus.appendChild(hint);
    } else if (kind === "rejected") {
      msg.textContent = `The push service rejected it (status ${statusCode ?? "unknown"}).`;
      testStatus.appendChild(msg);
    } else if (kind === "rate_limited") {
      msg.textContent = "Please wait a few seconds before requesting another test notification.";
      testStatus.appendChild(msg);
    } else if (kind === "not_subscribed") {
      msg.textContent = "This device is not subscribed to notifications.";
      testStatus.appendChild(msg);
    } else {
      msg.textContent = "Could not send test notification. Please try again.";
      testStatus.appendChild(msg);
    }
  }

  async function sendTestNotification(): Promise<void> {
    if (testBusy || busy || state !== "on") return;
    testBusy = true;
    testButton.disabled = true;
    testButton.textContent = "Sending test…";
    testStatus.hidden = false;
    testStatus.textContent = "";
    const progressText = document.createElement("p");
    progressText.className = "wx-srv-push-test-message";
    progressText.textContent = "Sending test notification…";
    testStatus.appendChild(progressText);

    cleanupTest();

    let confirmed = false;

    const onConfirmed = (): void => {
      if (confirmed) return;
      confirmed = true;
      cleanupTest();
      testBusy = false;
      testButton.disabled = false;
      testButton.textContent = "Send me a test notification";
      renderTestResult("confirmed");
    };

    if (typeof browserWindow.navigator.serviceWorker?.addEventListener === "function") {
      testSwListener = (event: MessageEvent) => {
        if (event.data && (event.data as { type?: unknown }).type === "push-shown") {
          onConfirmed();
        }
      };
      browserWindow.navigator.serviceWorker.addEventListener("message", testSwListener);
    }

    if (typeof BroadcastChannel !== "undefined") {
      try {
        testChannel = new BroadcastChannel("wx-server-push");
        testChannel.onmessage = (event: MessageEvent) => {
          if (event.data && (event.data as { type?: unknown }).type === "push-shown") {
            onConfirmed();
          }
        };
      } catch {
        // Ignore
      }
    }

    try {
      const response = await request(
        `${SUBSCRIPTION_PATH}/${encodeURIComponent(deps.deviceId)}/test`,
        {
          method: "POST",
          headers: authHeaders(),
        },
      );

      if (response.status === 429) {
        cleanupTest();
        testBusy = false;
        testButton.disabled = false;
        testButton.textContent = "Send me a test notification";
        renderTestResult("rate_limited");
        return;
      }

      if (response.status === 404) {
        cleanupTest();
        testBusy = false;
        testButton.disabled = false;
        testButton.textContent = "Send me a test notification";
        state = "needs_re-enabling";
        render();
        renderTestResult("not_subscribed");
        return;
      }

      if (!response.ok) {
        cleanupTest();
        testBusy = false;
        testButton.disabled = false;
        testButton.textContent = "Send me a test notification";
        renderTestResult("error", response.status);
        return;
      }

      const data = (await response.json()) as { ok?: unknown; statusCode?: unknown };
      const statusCode = typeof data.statusCode === "number" ? data.statusCode : 0;

      if (data.ok !== true) {
        cleanupTest();
        testBusy = false;
        testButton.disabled = false;
        testButton.textContent = "Send me a test notification";
        renderTestResult("rejected", statusCode);
        return;
      }

      if (confirmed) return;

      progressText.textContent = "Google accepted it. Waiting for phone confirmation…";

      testTimeoutId = browserWindow.setTimeout(() => {
        if (confirmed) return;
        cleanupTest();
        testBusy = false;
        testButton.disabled = false;
        testButton.textContent = "Send me a test notification";
        renderTestResult("timeout");
      }, 10_000);
    } catch {
      cleanupTest();
      testBusy = false;
      testButton.disabled = false;
      testButton.textContent = "Send me a test notification";
      renderTestResult("error");
    }
  }

  const onClick = (): void => {
    if (busy) return;
    if (state === "on") void disable();
    else if (state !== "blocked") void enable();
  };
  button.addEventListener("click", onClick);

  const onTestClick = (): void => {
    void sendTestNotification();
  };
  testButton.addEventListener("click", onTestClick);

  render();
  void loadState();

  return {
    element: root,
    teardown(): void {
      destroyed = true;
      cleanupTest();
      button.removeEventListener("click", onClick);
      testButton.removeEventListener("click", onTestClick);
      root.remove();
    },
  };
}
