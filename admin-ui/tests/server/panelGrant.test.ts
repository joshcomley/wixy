// The Server panel's device-grant behaviour (spec/server-chat/03-permanent-unlock.md §1-§8
// as amended): a mount with "Keep this device unlocked" on opens straight into the chat via
// `POST /unlock-with-grant`; idle and route-away stay quiet while a grant is active; every
// deliberate lock (and every checkbox-caused lock) PAUSES the grant; the token is re-minted
// silently 5 minutes before it expires or on a 401; and a background switch is governed by
// the two "lock when I change tab / lock my screen" checkboxes, with a 500ms fail-closed
// shield for the cases the browser cannot tell apart (Idle Detection API `screenState`).
//
// `panel.test.ts` already covers the no-grant behaviour; the tests here that touch it only
// prove it is UNCHANGED.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminApi, ServerVersion, SystemStatus } from "../../src/api";
import {
  FADE_MS,
  GRANT_RENEW_BEFORE_MS,
  GRANT_RENEW_MEDIA_DEFER_MS,
  GRANT_RENEW_RETRY_MS,
  IDLE_DETECTOR_THRESHOLD_MS,
  IDLE_LOCK_MS,
  MULTI_TAP_INTERVAL_MS,
  SHIELD_WAIT_MS,
} from "../../src/server/constants";
import { clearDeviceGrant, DEVICE_GRANT_KEY, GRANT_PAUSED_KEY, storeDeviceGrant } from "../../src/server/deviceGrant";
import {
  LOCK_ON_SCREEN_KEY,
  LOCK_ON_TAB_KEY,
  LOCK_PREFS_CHANGED_EVENT,
  SCREENLOCK_PROVEN_KEY,
} from "../../src/server/lockSettings";
import { mountServerPanel, type ServerPanel, type ServerPanelDeps } from "../../src/server/panel";
import type { CreateServerChatView, LockHooks, ServerChatView, ServerSession } from "../../src/server/types";

// -- Fixtures -----------------------------------------------------------------------------

const GRANT = { grantId: "0123456789abcdef0123456789abcdef", secret: "A".repeat(43) } as const;
const TOKEN_LIFETIME_S = 3600;
/** When, after a mint, the early renewal fires. */
const RENEW_AT_MS = TOKEN_LIFETIME_S * 1000 - GRANT_RENEW_BEFORE_MS;
const MARGIN_MS = 1000;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function fakeSystemStatus(): SystemStatus {
  return {
    backup: { lastAttemptAt: null, ok: null, verified: null, error: null, stale: false },
    diskUsage: { totalBytes: 100, usedBytes: 50, freeBytes: 50 },
    lastPublish: null,
    engine: { currentSha: null, edition: "fleet" },
  };
}

const FAKE_VERSION: ServerVersion = { shaFull: null, count: 1 };

interface TrackedChatFactory {
  factoryCalls: number;
  attachCalls: ServerSession[];
  detachCalls: number;
  disposeCalls: number;
  hooks: LockHooks | null;
  createServerChatView: CreateServerChatView;
}

function trackedChatViewFactory(): TrackedChatFactory {
  const tracked: TrackedChatFactory = {
    factoryCalls: 0,
    attachCalls: [],
    detachCalls: 0,
    disposeCalls: 0,
    hooks: null,
    createServerChatView: (deps) => {
      tracked.factoryCalls += 1;
      tracked.hooks = deps.hooks;
      const element = document.createElement("div");
      element.className = "wx-srv-thread wx-srv-chat-fake";
      const view: ServerChatView = {
        element,
        attach: (session) => tracked.attachCalls.push(session),
        detach: () => {
          tracked.detachCalls += 1;
        },
        dispose: () => {
          tracked.disposeCalls += 1;
        },
      };
      return view;
    },
  };
  return tracked;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at index ${index} (have ${items.length})`);
  return item;
}

// -- A fake Idle Detection API ------------------------------------------------------------

class FakePermissionStatus extends EventTarget {
  state: PermissionState;
  constructor(state: PermissionState) {
    super();
    this.state = state;
  }
}

class FakeDetector extends EventTarget {
  screenState: "locked" | "unlocked" | null = null;
  startOptions: { threshold: number; signal?: AbortSignal } | null = null;
}

interface IdleRig {
  readonly detectors: FakeDetector[];
  readonly permission: FakePermissionStatus;
  /** Detectors that have been started and not aborted. */
  running(): FakeDetector[];
  lockScreen(): void;
  unlockScreen(): void;
  /** Changes the permission and fires its `change` event, like the browser does. */
  setPermission(state: PermissionState): void;
}

/** `startRejectsTimes: n` makes the first `n` calls to `detector.start()` reject (a permission
 * that reads "granted" but a start the browser refuses). Deliberately BOUNDED: an unbounded
 * rejection sends a panel that restarts its watcher on every failure into a microtask loop
 * that never lets the test runner yield. */
function installIdleDetector(state: PermissionState = "granted", options: { startRejectsTimes?: number } = {}): IdleRig {
  let startCalls = 0;
  const permission = new FakePermissionStatus(state);
  const detectors: FakeDetector[] = [];
  class Detector extends FakeDetector {
    constructor() {
      super();
      detectors.push(this);
    }
    start(startOptions: { threshold: number; signal?: AbortSignal }): Promise<void> {
      this.startOptions = startOptions;
      startCalls += 1;
      if (startCalls <= (options.startRejectsTimes ?? 0)) {
        return Promise.reject(new DOMException("denied", "NotAllowedError"));
      }
      return Promise.resolve();
    }
    static requestPermission(): Promise<"granted" | "denied"> {
      return Promise.resolve("granted");
    }
  }
  Object.defineProperty(window, "IdleDetector", { configurable: true, writable: true, value: Detector });
  Object.defineProperty(window.navigator, "permissions", {
    configurable: true,
    value: { query: () => Promise.resolve(permission) },
  });
  const running = (): FakeDetector[] =>
    detectors.filter((d) => d.startOptions !== null && d.startOptions.signal?.aborted !== true);
  const fire = (screenState: "locked" | "unlocked"): void => {
    const detector = running().at(-1);
    if (detector === undefined) throw new Error("no running IdleDetector to fire an event on");
    detector.screenState = screenState;
    detector.dispatchEvent(new Event("change"));
  };
  return {
    detectors,
    permission,
    running,
    lockScreen: () => fire("locked"),
    unlockScreen: () => fire("unlocked"),
    setPermission(next: PermissionState): void {
      permission.state = next;
      permission.dispatchEvent(new Event("change"));
    },
  };
}

function uninstallIdleDetector(): void {
  delete (window as unknown as { IdleDetector?: unknown }).IdleDetector;
  delete (window.navigator as unknown as { permissions?: unknown }).permissions;
}

// -- The suite ---------------------------------------------------------------------------

describe("mountServerPanel with a device grant and the lock checkboxes", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let api: Pick<AdminApi, "getSystemStatus" | "getServerVersion">;
  let grantCalls: RequestInit[];
  let pinCalls: RequestInit[];
  /** One entry is consumed per `unlock-with-grant` call; after they run out the default is a
   * fresh token that expires an hour after the call. */
  let grantAnswers: Array<() => Response | Promise<Response> | Error>;
  let panels: ServerPanel[];
  let tornDown: Set<ServerPanel>;
  let rig: IdleRig | null;

  beforeEach(() => {
    vi.useFakeTimers();
    grantCalls = [];
    pinCalls = [];
    grantAnswers = [];
    panels = [];
    tornDown = new Set();
    rig = null;
    fetchMock = vi.fn();
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/unlock-with-grant")) {
        grantCalls.push(init ?? {});
        const answer = grantAnswers.shift();
        if (answer !== undefined) {
          const result = answer();
          if (result instanceof Error) throw result;
          return result;
        }
        return jsonResponse({ token: `grant-tok-${grantCalls.length}`, expiresAt: expiresIn(TOKEN_LIFETIME_S) });
      }
      if (url.endsWith("/unlock")) {
        pinCalls.push(init ?? {});
        return jsonResponse({ token: "pin-tok", expiresAt: expiresIn(TOKEN_LIFETIME_S) });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    api = {
      getSystemStatus: vi.fn().mockResolvedValue(fakeSystemStatus()),
      getServerVersion: vi.fn().mockResolvedValue(FAKE_VERSION),
    };
  });

  afterEach(() => {
    for (const panel of panels) if (!tornDown.has(panel)) panel.teardown();
    uninstallIdleDetector();
    setHidden(false);
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
    window.localStorage.clear();
  });

  // -- Helpers ------------------------------------------------------------------------------

  async function flush(times = 40): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve();
  }

  function expiresIn(seconds: number): number {
    return Date.now() / 1000 + seconds;
  }

  function setHidden(hidden: boolean): void {
    Object.defineProperty(document, "visibilityState", { value: hidden ? "hidden" : "visible", configurable: true });
  }

  function hide(): void {
    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
  }

  function show(): void {
    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
  }

  function mount(deps: Partial<ServerPanelDeps> = {}): ServerPanel {
    const panel = mountServerPanel({ api, ...deps });
    document.body.appendChild(panel.element);
    const originalTeardown = panel.teardown.bind(panel);
    const wrapped: ServerPanel = {
      element: panel.element,
      teardown(): void {
        if (tornDown.has(wrapped)) return;
        tornDown.add(wrapped);
        originalTeardown();
      },
    };
    panels.push(wrapped);
    return wrapped;
  }

  /** Mounts and lets the panel's async start-up (the Idle Detection watcher, a grant unlock
   * that has an answer ready) settle. */
  async function mountSettled(deps: Partial<ServerPanelDeps> = {}): Promise<ServerPanel> {
    const panel = mount(deps);
    await flush();
    return panel;
  }

  function storeGrant(): void {
    window.localStorage.setItem(DEVICE_GRANT_KEY, JSON.stringify(GRANT));
  }

  function digitButton(root: HTMLElement, label: string): HTMLButtonElement {
    const button = Array.from(root.querySelectorAll<HTMLButtonElement>(".wx-srv-pinpad-key")).find(
      (b) => b.textContent === label,
    );
    if (button === undefined) throw new Error(`no pin pad key labelled ${label}`);
    return button;
  }

  function tap(button: HTMLButtonElement): void {
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    button.click();
  }

  async function unlockWithPin(panel: ServerPanel): Promise<void> {
    panel.element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    panel.element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(MULTI_TAP_INTERVAL_MS + 1);
    (panel.element.querySelector(".wx-srv-affordance") as HTMLButtonElement).click();
    for (const digit of "1234") tap(digitButton(panel.element, digit));
    tap(digitButton(panel.element, "✓"));
    await flush();
  }

  function chatOpen(panel: ServerPanel): boolean {
    return panel.element.querySelector(".wx-srv-thread") !== null;
  }

  function granting(panel: ServerPanel): boolean {
    return panel.element.classList.contains("wx-srv-granting");
  }

  function paused(): boolean {
    return window.localStorage.getItem(GRANT_PAUSED_KEY) === "1";
  }

  function pinPadShown(panel: ServerPanel): boolean {
    return !(panel.element.querySelector(".wx-srv-pinpad-host") as HTMLElement).hidden;
  }

  /** A panel unlocked by its stored grant, with the fake chat view tracked. */
  async function mountUnlockedByGrant(): Promise<{ panel: ServerPanel; chat: TrackedChatFactory }> {
    storeGrant();
    const chat = trackedChatViewFactory();
    const panel = await mountSettled({ createServerChatView: chat.createServerChatView });
    expect(chatOpen(panel)).toBe(true);
    return { panel, chat };
  }

  async function mountUnlockedByPin(): Promise<{ panel: ServerPanel; chat: TrackedChatFactory }> {
    const chat = trackedChatViewFactory();
    const panel = await mountSettled({ createServerChatView: chat.createServerChatView });
    await unlockWithPin(panel);
    expect(chatOpen(panel)).toBe(true);
    return { panel, chat };
  }

  function requireHooks(chat: TrackedChatFactory): LockHooks {
    if (chat.hooks === null) throw new Error("hooks not captured");
    return chat.hooks;
  }

  function lastAttach(chat: TrackedChatFactory): ServerSession {
    return at(chat.attachCalls, chat.attachCalls.length - 1);
  }

  function escape(): void {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  function twoTapsIn(panel: ServerPanel): void {
    const host = panel.element.querySelector(".wx-srv-chat-host") as HTMLElement;
    host.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    host.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    host.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    host.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  }

  // ============================================================================================
  // A mount with the setting on
  // ============================================================================================

  describe("mount with a device grant that is on and not paused", () => {
    it("shows nothing while the grant answers, then opens the chat with the returned token and no PIN", async () => {
      storeGrant();
      const answer = deferred<Response>();
      grantAnswers.push(() => answer.promise);
      const chat = trackedChatViewFactory();

      const panel = mount({ createServerChatView: chat.createServerChatView });

      expect(granting(panel)).toBe(true);
      expect(chatOpen(panel)).toBe(false);
      expect(pinPadShown(panel)).toBe(false);
      expect((panel.element.querySelector(".wx-srv-affordance") as HTMLElement).hidden).toBe(true);
      expect(chat.factoryCalls).toBe(0);

      answer.resolve(jsonResponse({ token: "grant-tok", expiresAt: expiresIn(TOKEN_LIFETIME_S) }));
      await flush();

      expect(granting(panel)).toBe(false);
      expect(chatOpen(panel)).toBe(true);
      expect(pinPadShown(panel)).toBe(false);
      expect(chat.attachCalls).toHaveLength(1);
      expect(at(chat.attachCalls, 0).token).toBe("grant-tok");
    });

    it("POSTs /unlock-with-grant with the request-guard headers, the grant, and no PIN", async () => {
      await mountUnlockedByGrant();

      expect(grantCalls).toHaveLength(1);
      expect(pinCalls).toHaveLength(0);
      const init = at(grantCalls, 0);
      expect(init.method).toBe("POST");
      const headers = init.headers as Headers;
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("X-Wixy-Server-Unlock")).toBe("1");
      expect(headers.get("X-Wixy-Server-Token")).toBeNull();
      expect(JSON.parse(String(init.body))).toEqual({ grantId: GRANT.grantId, secret: GRANT.secret });
      expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/server/unlock-with-grant");
    });

    it("never shows the decoy's reveal affordance or the PIN pad on the way in", async () => {
      storeGrant();
      const panel = mount();
      expect(pinPadShown(panel)).toBe(false);
      expect((panel.element.querySelector(".wx-srv-affordance") as HTMLElement).hidden).toBe(true);
      await flush();
      expect(pinPadShown(panel)).toBe(false);
      expect((panel.element.querySelector(".wx-srv-affordance") as HTMLElement).hidden).toBe(true);
    });

    it("a 401 grant_invalid clears BOTH keys and shows the decoy", async () => {
      storeGrant();
      grantAnswers.push(() => jsonResponse({ error: "grant_invalid" }, 401));
      const panel = await mountSettled();

      expect(chatOpen(panel)).toBe(false);
      expect(granting(panel)).toBe(false);
      expect(window.localStorage.getItem(DEVICE_GRANT_KEY)).toBeNull();
      expect(window.localStorage.getItem(GRANT_PAUSED_KEY)).toBeNull();
      // ...and the decoy works as usual: one tap reveals the affordance.
      panel.element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      panel.element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      expect((panel.element.querySelector(".wx-srv-affordance") as HTMLElement).hidden).toBe(false);
    });

    it("a network error keeps the grant and shows the decoy", async () => {
      storeGrant();
      grantAnswers.push(() => new TypeError("Failed to fetch"));
      const panel = await mountSettled();

      expect(chatOpen(panel)).toBe(false);
      expect(granting(panel)).toBe(false);
      expect(window.localStorage.getItem(DEVICE_GRANT_KEY)).not.toBeNull();
      expect(paused()).toBe(false);
    });

    it.each([
      ["429 rate limited", () => jsonResponse({ error: "rate_limited", retryAfterS: 30 }, 429, { "Retry-After": "30" })],
      ["503", () => jsonResponse({ error: "down" }, 503)],
      ["a 200 with no token", () => jsonResponse({})],
      ["a 500", () => jsonResponse({ error: "boom" }, 500)],
    ])("%s keeps the grant and shows the decoy", async (_name, answer) => {
      storeGrant();
      grantAnswers.push(answer);
      const panel = await mountSettled();

      expect(chatOpen(panel)).toBe(false);
      expect(window.localStorage.getItem(DEVICE_GRANT_KEY)).not.toBeNull();
    });

    it("after a failed mount the decoy and PIN flow work, and a PIN unlock opens the chat", async () => {
      storeGrant();
      grantAnswers.push(() => new TypeError("offline"));
      const panel = await mountSettled();
      await unlockWithPin(panel);

      expect(chatOpen(panel)).toBe(true);
      expect(pinCalls).toHaveLength(1);
    });

    it("a stored value that is not exactly what the server hands out is treated as OFF: no request, the decoy", async () => {
      window.localStorage.setItem(DEVICE_GRANT_KEY, JSON.stringify({ grantId: "nope", secret: "short" }));
      const panel = await mountSettled();
      expect(grantCalls).toHaveLength(0);
      expect(chatOpen(panel)).toBe(false);
      expect(granting(panel)).toBe(false);
    });

    it("unreadable JSON in the grant key is treated as OFF", async () => {
      window.localStorage.setItem(DEVICE_GRANT_KEY, "{not json");
      const panel = await mountSettled();
      expect(grantCalls).toHaveLength(0);
      expect(chatOpen(panel)).toBe(false);
    });

    it("a paused grant is ignored: the decoy, no request", async () => {
      storeGrant();
      window.localStorage.setItem(GRANT_PAUSED_KEY, "1");
      const panel = await mountSettled();

      expect(grantCalls).toHaveLength(0);
      expect(granting(panel)).toBe(false);
      expect(chatOpen(panel)).toBe(false);
      expect(window.localStorage.getItem(DEVICE_GRANT_KEY)).not.toBeNull();
    });

    it("with no grant at all the panel mounts on the decoy and asks for nothing", async () => {
      const panel = await mountSettled();
      expect(grantCalls).toHaveLength(0);
      expect(pinCalls).toHaveLength(0);
      expect(granting(panel)).toBe(false);
      expect(chatOpen(panel)).toBe(false);
    });

    it("a lock while the grant is still answering wins: the late answer never resurrects the chat", async () => {
      storeGrant();
      const answer = deferred<Response>();
      grantAnswers.push(() => answer.promise);
      const chat = trackedChatViewFactory();
      const panel = mount({ createServerChatView: chat.createServerChatView });
      expect(granting(panel)).toBe(true);

      escape();
      expect(granting(panel)).toBe(false);
      answer.resolve(jsonResponse({ token: "late", expiresAt: expiresIn(TOKEN_LIFETIME_S) }));
      await flush();

      expect(chatOpen(panel)).toBe(false);
      expect(chat.attachCalls).toHaveLength(0);
    });

    it("Escape while the grant is answering is a deliberate lock: it pauses the grant", async () => {
      storeGrant();
      grantAnswers.push(() => new Promise<Response>(() => {}));
      mount();
      escape();
      expect(paused()).toBe(true);
    });

    it("a tab going to the background while the grant is answering locks without pausing (nothing was shown)", async () => {
      storeGrant();
      const answer = deferred<Response>();
      grantAnswers.push(() => answer.promise);
      const chat = trackedChatViewFactory();
      const panel = mount({ createServerChatView: chat.createServerChatView });

      hide();
      answer.resolve(jsonResponse({ token: "late", expiresAt: expiresIn(TOKEN_LIFETIME_S) }));
      await flush();

      expect(chatOpen(panel)).toBe(false);
      expect(chat.attachCalls).toHaveLength(0);
      expect(paused()).toBe(false);
    });

    it("tearing the panel down while the grant answers never opens a chat", async () => {
      storeGrant();
      const answer = deferred<Response>();
      grantAnswers.push(() => answer.promise);
      const chat = trackedChatViewFactory();
      const panel = mount({ createServerChatView: chat.createServerChatView });
      panel.teardown();
      answer.resolve(jsonResponse({ token: "late", expiresAt: expiresIn(TOKEN_LIFETIME_S) }));
      await flush();
      expect(chat.attachCalls).toHaveLength(0);
    });
  });

  // ============================================================================================
  // Automatic locks that a grant silences
  // ============================================================================================

  describe("with a grant active, idle and route-away stay quiet", () => {
    it("ten minutes without a touch never fades or locks the chat", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(chatOpen(panel)).toBe(true);
      expect(panel.element.querySelector(".wx-srv-chat-host")?.classList.contains("wx-srv-fading")).toBe(false);
      expect(chat.detachCalls).toBe(0);
    });

    it("the same is true after activity events (nothing restarts a timer that does not exist)", async () => {
      const { panel } = await mountUnlockedByGrant();
      document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS * 6);
      expect(chatOpen(panel)).toBe(true);
    });

    it("control: without a grant the same chat fades and detaches after 10 seconds", async () => {
      const { panel, chat } = await mountUnlockedByPin();
      await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS + FADE_MS + 10);
      expect(chatOpen(panel)).toBe(false);
      expect(chat.detachCalls).toBe(1);
    });

    it("tearing the panel down leaves the open chat attached (the next visit re-mints); without a grant it detaches", async () => {
      const withGrant = await mountUnlockedByGrant();
      withGrant.panel.teardown();
      expect(withGrant.chat.detachCalls).toBe(0);
      expect(withGrant.chat.disposeCalls).toBe(1);

      document.body.innerHTML = "";
      window.localStorage.clear();
      const withoutGrant = await mountUnlockedByPin();
      withoutGrant.panel.teardown();
      expect(withoutGrant.chat.detachCalls).toBe(1);
      expect(withoutGrant.chat.disposeCalls).toBe(1);
    });

    it("a grant turned ON while the chat is open stops the idle lock at once", async () => {
      const { panel } = await mountUnlockedByPin();
      await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS - 2_000);
      storeDeviceGrant(window, GRANT);
      await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS * 6);
      expect(chatOpen(panel)).toBe(true);
    });

    it("a grant turned OFF while the chat is open brings idle back, measured from the last activity", async () => {
      const { panel } = await mountUnlockedByGrant();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(chatOpen(panel)).toBe(true);

      clearDeviceGrant(window);
      await vi.advanceTimersByTimeAsync(FADE_MS + 50);

      expect(chatOpen(panel)).toBe(false);
    });

    it("a pause written in another tab (a storage event) also brings idle back", async () => {
      const { panel } = await mountUnlockedByGrant();
      await vi.advanceTimersByTimeAsync(60_000);
      window.localStorage.setItem(GRANT_PAUSED_KEY, "1");
      window.dispatchEvent(new StorageEvent("storage", { key: GRANT_PAUSED_KEY, newValue: "1" }));
      await vi.advanceTimersByTimeAsync(FADE_MS + 50);
      expect(chatOpen(panel)).toBe(false);
    });

    it("the decoy's reveal button and the PIN pad still idle out with a grant on (only the open chat is exempt)", async () => {
      storeGrant();
      grantAnswers.push(() => new TypeError("offline"));
      const panel = await mountSettled();
      panel.element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      panel.element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      expect((panel.element.querySelector(".wx-srv-affordance") as HTMLElement).hidden).toBe(false);

      await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS + 10);
      expect((panel.element.querySelector(".wx-srv-affordance") as HTMLElement).hidden).toBe(true);
    });
  });

  // ============================================================================================
  // §9 (audit F4 ruling): a PIN unlock is never itself bound
  // ============================================================================================

  describe("a PIN unlock exchanges for the bound session when the device holds a paused grant", () => {
    /** A paused grant (e.g. left over from an earlier panic) means the mount shows the
     * ordinary PIN flow rather than auto-unlocking — exactly the case §9 point 6 describes:
     * "a device that re-entered its PIN after a panic". */
    function storePausedGrant(): void {
      storeGrant();
      window.localStorage.setItem(GRANT_PAUSED_KEY, "1");
    }

    it("submits /unlock-with-grant right after the PIN succeeds, and clears the pause first", async () => {
      storePausedGrant();
      const panel = await mountSettled();
      expect(chatOpen(panel)).toBe(false);

      const exchange = deferred<Response>();
      grantAnswers.push(() => exchange.promise);
      await unlockWithPin(panel);

      expect(chatOpen(panel)).toBe(true);
      expect(pinCalls).toHaveLength(1);
      expect(grantCalls).toHaveLength(1);
      expect(paused()).toBe(false);
    });

    it("grantActive stays false while the exchange is pending: idle keeps counting down", async () => {
      storePausedGrant();
      const panel = await mountSettled();
      const exchange = deferred<Response>();
      grantAnswers.push(() => exchange.promise);
      await unlockWithPin(panel);
      expect(chatOpen(panel)).toBe(true);

      // Never resolved: the exchange stays pending for the rest of this test.
      await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS + FADE_MS + 10);
      expect(chatOpen(panel)).toBe(false);
    });

    it("once the exchange lands, grantActive becomes true and idle stops counting", async () => {
      storePausedGrant();
      const panel = await mountSettled();
      const exchange = deferred<Response>();
      grantAnswers.push(() => exchange.promise);
      await unlockWithPin(panel);
      expect(chatOpen(panel)).toBe(true);

      exchange.resolve(jsonResponse({ token: "bound-after-pin", expiresAt: expiresIn(TOKEN_LIFETIME_S) }));
      await flush();

      await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS * 6);
      expect(chatOpen(panel)).toBe(true);
    });

    it("a grant_invalid exchange forgets the grant but never locks the PIN session it just got", async () => {
      storePausedGrant();
      const panel = await mountSettled();
      grantAnswers.push(() => jsonResponse({ error: "grant_invalid" }, 401));
      await unlockWithPin(panel);

      expect(chatOpen(panel)).toBe(true);
      expect(window.localStorage.getItem(DEVICE_GRANT_KEY)).toBeNull();
    });

    it("a network error on the exchange leaves the grant alone and the PIN session unaffected", async () => {
      storePausedGrant();
      const panel = await mountSettled();
      grantAnswers.push(() => new TypeError("offline"));
      await unlockWithPin(panel);

      expect(chatOpen(panel)).toBe(true);
      expect(window.localStorage.getItem(DEVICE_GRANT_KEY)).not.toBeNull();
    });

    it("no stored grant at all: no exchange call, and idle behaves exactly as it always has", async () => {
      const panel = await mountSettled();
      await unlockWithPin(panel);
      expect(grantCalls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS + FADE_MS + 10);
      expect(chatOpen(panel)).toBe(false);
    });
  });

  // ============================================================================================
  // Pausing the grant
  // ============================================================================================

  describe("deliberate locks pause the grant", () => {
    it("panic locks, pauses the grant, and a reload then shows the decoy with NO request", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      requireHooks(chat).lockNow("panic");

      expect(chatOpen(panel)).toBe(false);
      expect(paused()).toBe(true);
      expect(window.localStorage.getItem(DEVICE_GRANT_KEY)).not.toBeNull();

      panel.teardown();
      document.body.innerHTML = "";
      grantCalls.length = 0;
      const reloaded = await mountSettled();

      expect(grantCalls).toHaveLength(0);
      expect(granting(reloaded)).toBe(false);
      expect(chatOpen(reloaded)).toBe(false);
    });

    it("a multi-tap in the chat locks and pauses the grant", async () => {
      const { panel } = await mountUnlockedByGrant();
      twoTapsIn(panel);
      expect(chatOpen(panel)).toBe(false);
      expect(paused()).toBe(true);
    });

    it("Escape locks and pauses the grant", async () => {
      const { panel } = await mountUnlockedByGrant();
      escape();
      expect(chatOpen(panel)).toBe(false);
      expect(paused()).toBe(true);
    });

    it("a lock that pauses the grant also detaches the chat subtree — nothing readable survives", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      requireHooks(chat).lockNow("panic");
      expect(chat.detachCalls).toBe(1);
      expect(panel.element.querySelector(".wx-srv-thread")).toBeNull();
      expect((panel.element.querySelector(".wx-srv-chat-host") as HTMLElement).hidden).toBe(true);
    });

    it("a PIN unlock clears the pause and the device is permanently unlocked again", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      requireHooks(chat).lockNow("panic");
      expect(paused()).toBe(true);

      await unlockWithPin(panel);

      expect(chatOpen(panel)).toBe(true);
      expect(paused()).toBe(false);
      expect(window.localStorage.getItem(DEVICE_GRANT_KEY)).not.toBeNull();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(chatOpen(panel)).toBe(true);
    });

    it("after the pause is cleared a reload opens straight into the chat again", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      requireHooks(chat).lockNow("panic");
      await unlockWithPin(panel);
      panel.teardown();
      document.body.innerHTML = "";
      grantCalls.length = 0;

      const reloaded = await mountSettled();

      expect(grantCalls).toHaveLength(1);
      expect(chatOpen(reloaded)).toBe(true);
    });

    it("panic with NO grant leaves no pause key behind", async () => {
      const { chat } = await mountUnlockedByPin();
      requireHooks(chat).lockNow("panic");
      expect(window.localStorage.getItem(GRANT_PAUSED_KEY)).toBeNull();
    });

    it("locks the grant exists to smooth over do NOT pause it: an expiry lock and a routed-away lock", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      requireHooks(chat).lockNow("expired");
      expect(chatOpen(panel)).toBe(false);
      expect(paused()).toBe(false);
      panel.teardown();
      document.body.innerHTML = "";
      grantCalls.length = 0;
      const reloaded = await mountSettled();
      expect(chatOpen(reloaded)).toBe(true);
    });

    it("Escape on the decoy (no chat was open) does not pause an active grant", async () => {
      storeGrant();
      grantAnswers.push(() => new TypeError("offline"));
      await mountSettled();
      escape();
      expect(paused()).toBe(false);
    });

    it("a multi-tap on the decoy or the PIN pad does not pause an active grant", async () => {
      storeGrant();
      grantAnswers.push(() => new TypeError("offline"));
      const panel = await mountSettled();
      panel.element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      panel.element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      panel.element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      panel.element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      expect(paused()).toBe(false);
    });

    it("a grant that cannot record its pause is dropped (storage refusing the write)", async () => {
      const { chat } = await mountUnlockedByGrant();
      const realSetItem = Storage.prototype.setItem;
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
        if (key === GRANT_PAUSED_KEY) throw new DOMException("quota", "QuotaExceededError");
        realSetItem.call(this, key, value);
      });

      requireHooks(chat).lockNow("panic");

      expect(window.localStorage.getItem(DEVICE_GRANT_KEY)).toBeNull();
      vi.restoreAllMocks();
    });
  });

  // ============================================================================================
  // Silent renewal
  // ============================================================================================

  describe("silent token renewal", () => {
    it("re-mints 5 minutes before expiry, re-attaches the chat with the new token, and shows no change", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      await vi.advanceTimersByTimeAsync(RENEW_AT_MS - MARGIN_MS);
      expect(grantCalls).toHaveLength(1);
      expect(chat.attachCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2 * MARGIN_MS);
      await flush();

      expect(grantCalls).toHaveLength(2);
      expect(chat.attachCalls).toHaveLength(2);
      expect(lastAttach(chat).token).toBe("grant-tok-2");
      expect(chat.detachCalls).toBe(0);
      expect(chatOpen(panel)).toBe(true);
      expect(granting(panel)).toBe(false);
      expect(pinPadShown(panel)).toBe(false);
    });

    it("the renewal request is the same guarded, PIN-less grant request", async () => {
      await mountUnlockedByGrant();
      await vi.advanceTimersByTimeAsync(RENEW_AT_MS + MARGIN_MS);
      await flush();
      const init = at(grantCalls, 1);
      expect((init.headers as Headers).get("X-Wixy-Server-Unlock")).toBe("1");
      expect(JSON.parse(String(init.body))).toEqual({ grantId: GRANT.grantId, secret: GRANT.secret });
      expect(pinCalls).toHaveLength(0);
    });

    it("re-arms both timers: the old expiry never fires, and the next renewal is 5 minutes before the NEW expiry", async () => {
      const { panel } = await mountUnlockedByGrant();
      await vi.advanceTimersByTimeAsync(RENEW_AT_MS + MARGIN_MS);
      await flush();
      expect(grantCalls).toHaveLength(2);

      // Past the FIRST token's expiry: a stale expiry timer would trigger a last-chance renewal.
      await vi.advanceTimersByTimeAsync(TOKEN_LIFETIME_S * 1000 - RENEW_AT_MS + 20_000);
      await flush();
      expect(grantCalls).toHaveLength(2);
      expect(chatOpen(panel)).toBe(true);

      // The second token was minted at RENEW_AT_MS; its own renewal is RENEW_AT_MS later.
      await vi.advanceTimersByTimeAsync(RENEW_AT_MS - (TOKEN_LIFETIME_S * 1000 - RENEW_AT_MS + 20_000) + 2 * MARGIN_MS);
      await flush();
      expect(grantCalls).toHaveLength(3);
      expect(chatOpen(panel)).toBe(true);
    });

    it("keeps the chat unlocked across several renewals (the session never expires under a grant)", async () => {
      const { panel } = await mountUnlockedByGrant();
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(RENEW_AT_MS + MARGIN_MS);
        await flush();
        expect(chatOpen(panel)).toBe(true);
      }
      expect(grantCalls).toHaveLength(5);
    });

    it("without a grant nothing is renewed: the token's expiry simply locks (unchanged)", async () => {
      const { panel } = await mountUnlockedByPin();
      await vi.advanceTimersByTimeAsync(TOKEN_LIFETIME_S * 1000 + MARGIN_MS);
      expect(grantCalls).toHaveLength(0);
      expect(chatOpen(panel)).toBe(false);
    });

    it("a renewal that finds the grant revoked clears both keys and locks", async () => {
      const { panel } = await mountUnlockedByGrant();
      grantAnswers.push(() => jsonResponse({ error: "grant_invalid" }, 401));
      await vi.advanceTimersByTimeAsync(RENEW_AT_MS + MARGIN_MS);
      await flush();

      expect(chatOpen(panel)).toBe(false);
      expect(window.localStorage.getItem(DEVICE_GRANT_KEY)).toBeNull();
      expect(window.localStorage.getItem(GRANT_PAUSED_KEY)).toBeNull();
    });

    it("a transient failure keeps the chat and retries after 30 seconds", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      grantAnswers.push(() => new TypeError("offline"));
      await vi.advanceTimersByTimeAsync(RENEW_AT_MS + MARGIN_MS);
      await flush();
      expect(grantCalls).toHaveLength(2);
      expect(chatOpen(panel)).toBe(true);
      expect(chat.attachCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(GRANT_RENEW_RETRY_MS);
      await flush();

      expect(grantCalls).toHaveLength(3);
      expect(chatOpen(panel)).toBe(true);
      expect(lastAttach(chat).token).toBe("grant-tok-3");
    });

    it("a 429 or 503 on renewal is transient too", async () => {
      const { panel } = await mountUnlockedByGrant();
      grantAnswers.push(() => jsonResponse({ error: "rate_limited", retryAfterS: 30 }, 429));
      grantAnswers.push(() => jsonResponse({ error: "down" }, 503));
      await vi.advanceTimersByTimeAsync(RENEW_AT_MS + MARGIN_MS);
      await flush();
      await vi.advanceTimersByTimeAsync(GRANT_RENEW_RETRY_MS);
      await flush();
      await vi.advanceTimersByTimeAsync(GRANT_RENEW_RETRY_MS);
      await flush();

      expect(grantCalls).toHaveLength(4);
      expect(chatOpen(panel)).toBe(true);
      expect(window.localStorage.getItem(DEVICE_GRANT_KEY)).not.toBeNull();
    });

    it("when every renewal fails the chat locks at the token's expiry, and the grant is kept and NOT paused", async () => {
      const { panel } = await mountUnlockedByGrant();
      for (let i = 0; i < 40; i++) grantAnswers.push(() => new TypeError("offline"));
      await vi.advanceTimersByTimeAsync(TOKEN_LIFETIME_S * 1000 + 5 * MARGIN_MS);
      await flush();

      expect(chatOpen(panel)).toBe(false);
      expect(window.localStorage.getItem(DEVICE_GRANT_KEY)).not.toBeNull();
      expect(paused()).toBe(false);
    });

    it("a renewal is put off while a voice note or video plays, and runs once it stops", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      const release = requireHooks(chat).suspend("mediaPlaying");
      await vi.advanceTimersByTimeAsync(RENEW_AT_MS + MARGIN_MS);
      await flush();
      expect(grantCalls).toHaveLength(1);
      expect(chat.attachCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(GRANT_RENEW_MEDIA_DEFER_MS);
      await flush();
      expect(grantCalls).toHaveLength(1);

      release();
      await vi.advanceTimersByTimeAsync(GRANT_RENEW_MEDIA_DEFER_MS);
      await flush();
      expect(grantCalls).toHaveLength(2);
      expect(chatOpen(panel)).toBe(true);
    });

    it("but never past the last-chance window: a still-playing note does not stop the renewal a minute before expiry", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      requireHooks(chat).suspend("mediaPlaying");
      await vi.advanceTimersByTimeAsync(TOKEN_LIFETIME_S * 1000 - 61_000);
      await flush();
      expect(grantCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2 * GRANT_RENEW_MEDIA_DEFER_MS);
      await flush();

      expect(grantCalls).toHaveLength(2);
      expect(chatOpen(panel)).toBe(true);
    });

    it("a media suspension does not defer the last-chance renewal at expiry", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      requireHooks(chat).suspend("mediaPlaying");
      // The scheduled renewal keeps deferring; the expiry timer's own attempt must still run.
      await vi.advanceTimersByTimeAsync(TOKEN_LIFETIME_S * 1000 + MARGIN_MS);
      await flush();
      expect(grantCalls.length).toBeGreaterThanOrEqual(2);
      expect(chatOpen(panel)).toBe(true);
    });
  });

  describe("a 401 while a grant is active", () => {
    it("renews instead of locking, and the chat stays open with the new token", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      await vi.advanceTimersByTimeAsync(11_000);

      requireHooks(chat).lockNow("unauthorized");
      await flush();

      expect(chatOpen(panel)).toBe(true);
      expect(grantCalls).toHaveLength(2);
      expect(lastAttach(chat).token).toBe("grant-tok-2");
      expect(chat.detachCalls).toBe(0);
      expect(paused()).toBe(false);
    });

    it("a second 401 within 10 seconds of that renewal locks (no renewal loop)", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      await vi.advanceTimersByTimeAsync(11_000);
      requireHooks(chat).lockNow("unauthorized");
      await flush();
      expect(chatOpen(panel)).toBe(true);

      await vi.advanceTimersByTimeAsync(5_000);
      requireHooks(chat).lockNow("unauthorized");

      expect(chatOpen(panel)).toBe(false);
      expect(grantCalls).toHaveLength(2);
    });

    it("a 401 more than 10 seconds after the last renewal renews again", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      await vi.advanceTimersByTimeAsync(11_000);
      requireHooks(chat).lockNow("unauthorized");
      await flush();
      await vi.advanceTimersByTimeAsync(11_000);
      requireHooks(chat).lockNow("unauthorized");
      await flush();

      expect(chatOpen(panel)).toBe(true);
      expect(grantCalls).toHaveLength(3);
    });

    it("a 401 right after the mount's own mint locks (the server is refusing fresh tokens)", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      await vi.advanceTimersByTimeAsync(2_000);
      requireHooks(chat).lockNow("unauthorized");
      expect(chatOpen(panel)).toBe(false);
      expect(grantCalls).toHaveLength(1);
    });

    it("two 401s while the renewal is in flight make ONE request and neither locks", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      await vi.advanceTimersByTimeAsync(11_000);
      const answer = deferred<Response>();
      grantAnswers.push(() => answer.promise);

      requireHooks(chat).lockNow("unauthorized");
      requireHooks(chat).lockNow("unauthorized");
      expect(chatOpen(panel)).toBe(true);
      expect(grantCalls).toHaveLength(2);

      answer.resolve(jsonResponse({ token: "renewed", expiresAt: expiresIn(TOKEN_LIFETIME_S) }));
      await flush();
      expect(chatOpen(panel)).toBe(true);
      expect(lastAttach(chat).token).toBe("renewed");
    });

    it("if the renewal finds the grant revoked it clears the keys and locks", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      await vi.advanceTimersByTimeAsync(11_000);
      grantAnswers.push(() => jsonResponse({ error: "grant_invalid" }, 401));

      requireHooks(chat).lockNow("unauthorized");
      await flush();

      expect(chatOpen(panel)).toBe(false);
      expect(window.localStorage.getItem(DEVICE_GRANT_KEY)).toBeNull();
    });

    it("if the renewal fails transiently it locks (the request that got the 401 cannot be trusted)", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      await vi.advanceTimersByTimeAsync(11_000);
      grantAnswers.push(() => new TypeError("offline"));

      requireHooks(chat).lockNow("unauthorized");
      await flush();

      expect(chatOpen(panel)).toBe(false);
      expect(window.localStorage.getItem(DEVICE_GRANT_KEY)).not.toBeNull();
    });

    it("a locked-while-renewing panel drops the late answer", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      await vi.advanceTimersByTimeAsync(11_000);
      const answer = deferred<Response>();
      grantAnswers.push(() => answer.promise);
      requireHooks(chat).lockNow("unauthorized");

      escape();
      answer.resolve(jsonResponse({ token: "late", expiresAt: expiresIn(TOKEN_LIFETIME_S) }));
      await flush();

      expect(chatOpen(panel)).toBe(false);
      expect(chat.attachCalls).toHaveLength(1);
    });

    it("control: with no grant a 401 locks exactly as before and asks for nothing", async () => {
      const { panel, chat } = await mountUnlockedByPin();
      requireHooks(chat).lockNow("unauthorized");
      expect(chatOpen(panel)).toBe(false);
      expect(grantCalls).toHaveLength(0);
    });

    it("control: with a PAUSED grant a 401 locks and asks for nothing", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      window.localStorage.setItem(GRANT_PAUSED_KEY, "1");
      window.dispatchEvent(new StorageEvent("storage", { key: GRANT_PAUSED_KEY, newValue: "1" }));
      await vi.advanceTimersByTimeAsync(11_000);
      requireHooks(chat).lockNow("unauthorized");
      expect(chatOpen(panel)).toBe(false);
      expect(grantCalls).toHaveLength(1);
    });
  });

  // ============================================================================================
  // "Lock when I change tab" / "Lock when I lock my screen" (§8)
  // ============================================================================================

  const SETTINGS = {
    "both on": {} as Record<string, string>,
    "both off": { [LOCK_ON_TAB_KEY]: "0", [LOCK_ON_SCREEN_KEY]: "0" },
    "tab off, screen on": { [LOCK_ON_TAB_KEY]: "0" },
    "tab on, screen off": { [LOCK_ON_SCREEN_KEY]: "0" },
  } as const;
  type SettingsName = keyof typeof SETTINGS;

  type Cause = "a screen lock is seen" | "no event, proven device" | "no event, unproven device";

  /** Is the chat open again once the background switch has fully resolved? */
  const EXPECT_OPEN: Record<SettingsName, Record<Cause, boolean>> = {
    // Lock at once: never opens again on its own, whatever the cause.
    "both on": {
      "a screen lock is seen": false,
      "no event, proven device": false,
      "no event, unproven device": false,
    },
    // Never locks on a background switch.
    "both off": { "a screen lock is seen": true, "no event, proven device": true, "no event, unproven device": true },
    "tab off, screen on": {
      "a screen lock is seen": false, // the screen box is ticked
      "no event, proven device": true, // a proven device reports a screen lock: this was a tab switch
      "no event, unproven device": false, // ambiguous: fail closed
    },
    "tab on, screen off": {
      "a screen lock is seen": true, // the screen box is unticked
      "no event, proven device": false, // a tab switch, and the tab box is ticked
      "no event, unproven device": false, // ambiguous: fail closed
    },
  };

  function applySettings(name: SettingsName): void {
    for (const [key, value] of Object.entries(SETTINGS[name])) window.localStorage.setItem(key, value);
  }

  const MATRIX_CASES: Array<[SettingsName, Cause, boolean]> = [];
  for (const name of Object.keys(SETTINGS) as SettingsName[]) {
    for (const cause of ["a screen lock is seen", "no event, proven device", "no event, unproven device"] as const) {
      MATRIX_CASES.push([name, cause, true], [name, cause, false]);
    }
  }

  describe("a background switch: every setting x cause x grant", () => {
    it.each(MATRIX_CASES)("%s / %s / grant active: %s", async (name, cause, withGrant) => {
      applySettings(name);
      if (cause === "no event, proven device") window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      let panel: ServerPanel;
      if (withGrant) {
        // The detector must be running before the unlock: `mountUnlockedByGrant` settles.
        ({ panel } = await mountUnlockedByGrant());
      } else {
        ({ panel } = await mountUnlockedByPin());
      }
      expect(rig.running()).toHaveLength(1);

      hide();
      if (cause === "a screen lock is seen") rig.lockScreen();
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);

      const open = EXPECT_OPEN[name][cause];
      expect(chatOpen(panel)).toBe(open);
      // A checkbox-caused lock pauses an active grant; a chat that stayed open or came back
      // does not. Without a grant there is nothing to pause.
      expect(paused()).toBe(withGrant && !open);
    });
  });

  describe("the shield", () => {
    it("detaches the chat at once and puts the decoy up, keeping the session until it resolves", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel, chat } = await mountUnlockedByPin();

      hide();

      expect(chatOpen(panel)).toBe(false);
      expect(chat.detachCalls).toBe(1);
      expect((panel.element.querySelector(".wx-srv-chat-host") as HTMLElement).hidden).toBe(true);
      expect(pinPadShown(panel)).toBe(false);
    });

    it("waits 500 ms after the page is visible again for queued events, then restores the same chat with the same session", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel, chat } = await mountUnlockedByPin();
      const sessionBefore = lastAttach(chat);
      hide();
      show();

      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS - 1);
      expect(chatOpen(panel)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(chatOpen(panel)).toBe(true);
      expect(chat.factoryCalls).toBe(1);
      expect(chat.attachCalls).toHaveLength(2);
      expect(lastAttach(chat)).toEqual(sessionBefore);
      expect(pinCalls).toHaveLength(1);
      expect(grantCalls).toHaveLength(0);
    });

    it("the wait runs from the RETURN, not from the hide", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();
      hide();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(chatOpen(panel)).toBe(false);

      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS - 1);
      expect(chatOpen(panel)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(chatOpen(panel)).toBe(true);
    });

    it("screen-lock evidence seen while away resolves the moment the page is back — no 500 ms wait", async () => {
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();
      hide();
      rig.lockScreen();

      show();

      expect(chatOpen(panel)).toBe(true); // tab on, screen off: a screen lock restores
    });

    it("evidence arriving INSIDE the 500 ms window resolves at that moment", async () => {
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();
      hide();
      show();
      await vi.advanceTimersByTimeAsync(200);
      expect(chatOpen(panel)).toBe(false);

      rig.lockScreen();

      expect(chatOpen(panel)).toBe(true);
    });

    it("evidence inside the window can also lock: tab off / screen on stays locked the moment it arrives", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();
      hide();
      show();
      await vi.advanceTimersByTimeAsync(100);

      rig.lockScreen();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS * 2);

      expect(chatOpen(panel)).toBe(false);
    });

    it("evidence that arrives AFTER the window has closed does not reopen a locked chat", async () => {
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();
      hide();
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1); // no evidence, unproven: locked
      expect(chatOpen(panel)).toBe(false);

      rig.lockScreen();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS * 2);

      expect(chatOpen(panel)).toBe(false);
    });

    it("going away again before the wait ends is a SECOND switch in one absence: the cause can no longer be read, so it stays locked on return", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();
      hide();
      show();
      await vi.advanceTimersByTimeAsync(300);
      hide();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS * 2);
      expect(chatOpen(panel)).toBe(false);

      // A single switch on this proven device would have restored; two do not.
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);
      expect(chatOpen(panel)).toBe(false);
    });

    it("a taint from a resolved shield does not leak into the next one: a clean single switch afterwards restores normally", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();

      // Taint this shield with a second switch in one absence; it resolves locked.
      hide();
      show();
      await vi.advanceTimersByTimeAsync(300);
      hide();
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);
      expect(chatOpen(panel)).toBe(false);

      // Unlock, then one ordinary tab switch: a fresh shield must not inherit the old taint.
      await unlockWithPin(panel);
      expect(chatOpen(panel)).toBe(true);
      hide();
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);
      expect(chatOpen(panel)).toBe(true);
    });

    it("Escape during the shield locks for good and pauses an active grant; the return brings nothing back", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByGrant();
      hide();
      escape();
      expect(paused()).toBe(true);

      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS * 2);

      expect(chatOpen(panel)).toBe(false);
    });

    it("an active grant is paused the moment the shield BEGINS, not when it resolves half a second after the owner is back", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      rig = installIdleDetector("granted"); // unproven: ambiguous, will stay locked
      await mountUnlockedByGrant();
      hide();
      expect(paused()).toBe(true);
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS - 1);
      expect(paused()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(paused()).toBe(true);
    });

    it("a page reloaded, closed or discarded while the shield is undecided finds the grant paused and asks for the PIN", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1"); // a switch with no event would RESTORE
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByGrant();
      hide();
      // The page never comes back to resolve anything (a discarded background tab).
      panel.teardown();
      document.body.innerHTML = "";
      grantCalls.length = 0;
      setHidden(false);

      const reloaded = await mountSettled();

      expect(grantCalls).toHaveLength(0);
      expect(chatOpen(reloaded)).toBe(false);
      expect(paused()).toBe(true);
    });

    it("a restore undoes the pause the shield wrote, so the setting is still on afterwards", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByGrant();
      hide();
      expect(paused()).toBe(true);
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);

      expect(chatOpen(panel)).toBe(true);
      expect(paused()).toBe(false);
      // ...and the very next reload still opens straight into the chat.
      panel.teardown();
      document.body.innerHTML = "";
      grantCalls.length = 0;
      const reloaded = await mountSettled();
      expect(grantCalls).toHaveLength(1);
      expect(chatOpen(reloaded)).toBe(true);
    });

    it("a token that expires while shielded is never brought back on return (no grant)", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();
      hide();
      await vi.advanceTimersByTimeAsync(TOKEN_LIFETIME_S * 1000 + MARGIN_MS);

      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS * 2);

      expect(chatOpen(panel)).toBe(false);
    });

    it("a grant renews the held session in the background, and the restore uses the renewed token", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel, chat } = await mountUnlockedByGrant();
      hide();
      await vi.advanceTimersByTimeAsync(RENEW_AT_MS + MARGIN_MS);
      await flush();
      expect(grantCalls).toHaveLength(2);
      expect(chat.attachCalls).toHaveLength(1); // no chat attached while shielded

      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);

      expect(chatOpen(panel)).toBe(true);
      expect(lastAttach(chat).token).toBe("grant-tok-2");
    });

    it("a token that ran out while shielded is re-minted by the grant on return, then the chat is restored", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel, chat } = await mountUnlockedByGrant();
      // While away, every scheduled renewal fails; the token then expires.
      for (let i = 0; i < 40; i++) grantAnswers.push(() => new TypeError("offline"));
      hide();
      await vi.advanceTimersByTimeAsync(TOKEN_LIFETIME_S * 1000 - MARGIN_MS);
      expect(chatOpen(panel)).toBe(false);
      grantAnswers.length = 0; // the network is back on return
      vi.setSystemTime(Date.now() + 5 * MARGIN_MS);

      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);
      await flush();

      expect(chatOpen(panel)).toBe(true);
      expect(lastAttach(chat).token.startsWith("grant-tok-")).toBe(true);
    });

    // Regression: with the token expired and a renewal already in flight, `renewSession("expiry")`
    // returns at once, so the shield used to wait on nothing; when the in-flight renewal then
    // succeeded the state stayed "shielded" forever (taps ignored, the PIN pad unreachable).
    // Spec §8: a harmless cause restores "with the in-memory session, or re-mint via the grant".
    it("a renewal already in flight when the shield resolves still ends in a restored chat", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel, chat } = await mountUnlockedByGrant();
      const pending = deferred<Response>();
      grantAnswers.push(() => pending.promise);
      hide();
      await vi.advanceTimersByTimeAsync(TOKEN_LIFETIME_S * 1000 + MARGIN_MS); // renewal in flight, token expired
      vi.setSystemTime(Date.now() + MARGIN_MS);
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);
      await flush();

      pending.resolve(jsonResponse({ token: "renewed", expiresAt: expiresIn(TOKEN_LIFETIME_S) }));
      await flush();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);

      expect(chatOpen(panel)).toBe(true);
      expect(lastAttach(chat).token).toBe("renewed");
    });
  });

  describe("the proof that a device reports screen locks", () => {
    it("is set by the first screen lock seen while away, and from then on 'no event' means a tab switch", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0"); // tab off, screen on
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();
      expect(window.localStorage.getItem(SCREENLOCK_PROVEN_KEY)).toBeNull();

      // 1. A screen lock while away: proves the device, and the (ticked) screen box locks.
      hide();
      rig.lockScreen();
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);
      expect(window.localStorage.getItem(SCREENLOCK_PROVEN_KEY)).toBe("1");
      expect(chatOpen(panel)).toBe(false);

      // 2. Unlock again, well after that lock (so it is not the next hide's lead-in). Now a switch
      // with no event is a tab change, and the tab box is off.
      await unlockWithPin(panel);
      await vi.advanceTimersByTimeAsync(5_000);
      hide();
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);
      expect(chatOpen(panel)).toBe(true);
    });

    it("before the proof, the very same switch with no event stays locked (fail closed)", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();
      hide();
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);
      expect(chatOpen(panel)).toBe(false);
      expect(window.localStorage.getItem(SCREENLOCK_PROVEN_KEY)).toBeNull();
    });

    it("counts a screen lock that arrives inside the 500 ms window after the return", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      rig = installIdleDetector("granted");
      await mountUnlockedByPin();
      hide();
      show();
      await vi.advanceTimersByTimeAsync(100);

      rig.lockScreen();

      expect(window.localStorage.getItem(SCREENLOCK_PROVEN_KEY)).toBe("1");
    });

    it("counts a screen lock seen while away even when the page was on the decoy", async () => {
      rig = installIdleDetector("granted");
      await mountSettled();
      hide();
      rig.lockScreen();
      expect(window.localStorage.getItem(SCREENLOCK_PROVEN_KEY)).toBe("1");
    });

    it("does NOT count a screen lock seen while the page stayed visible (that says nothing about a hide and return)", async () => {
      rig = installIdleDetector("granted");
      await mountUnlockedByPin();
      rig.lockScreen();
      expect(window.localStorage.getItem(SCREENLOCK_PROVEN_KEY)).toBeNull();
    });

    it("is cleared when the permission is lost", async () => {
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      await mountSettled();
      expect(window.localStorage.getItem(SCREENLOCK_PROVEN_KEY)).toBe("1");

      rig.setPermission("denied");

      expect(window.localStorage.getItem(SCREENLOCK_PROVEN_KEY)).toBeNull();
    });

    it("is cleared when the detector cannot start", async () => {
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted", { startRejectsTimes: 1 });
      await mountSettled();
      expect(window.localStorage.getItem(SCREENLOCK_PROVEN_KEY)).toBeNull();
    });

    it("with the permission lost the two boxes follow each other: tab off / screen on now locks at once", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();
      rig.setPermission("denied");

      hide();
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);

      expect(chatOpen(panel)).toBe(false);
    });
  });

  describe("a browser that cannot tell a screen lock from a tab switch", () => {
    async function unavailable(kind: "no api" | "prompt" | "denied"): Promise<void> {
      if (kind === "prompt") rig = installIdleDetector("prompt");
      else if (kind === "denied") rig = installIdleDetector("denied");
    }

    it.each(["no api", "prompt", "denied"] as const)(
      "(%s) stored tab off / screen on reads as 'lock' — the safe direction — and locks at once",
      async (kind) => {
        window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
        window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
        await unavailable(kind);
        const { panel } = await mountUnlockedByPin();

        hide();
        expect(chatOpen(panel)).toBe(false);
        show();
        await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);

        expect(chatOpen(panel)).toBe(false);
      },
    );

    it.each(["no api", "prompt", "denied"] as const)(
      "(%s) stored tab on / screen off reads as 'lock' and locks at once",
      async (kind) => {
        window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
        await unavailable(kind);
        const { panel } = await mountUnlockedByPin();

        hide();

        expect(chatOpen(panel)).toBe(false);
      },
    );

    it.each(["no api", "prompt", "denied"] as const)(
      "(%s) both boxes unticked still never lock on a background switch",
      async (kind) => {
        window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
        window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
        await unavailable(kind);
        const { panel } = await mountUnlockedByPin();

        hide();
        show();

        expect(chatOpen(panel)).toBe(true);
      },
    );

    it("(no api) the default still locks on hidden, exactly as before the checkboxes existed", async () => {
      const { panel, chat } = await mountUnlockedByPin();
      hide();
      expect(chatOpen(panel)).toBe(false);
      expect(chat.detachCalls).toBe(1);
    });

    // Regression: when the permission reads "granted" but `detector.start()` rejects,
    // `onScreenWatchLost` clears the proof flag, which used to announce a settings change every
    // time, and the panel's settings listener restarted the watcher, which rejected again — an
    // unbounded microtask loop that froze the page. It must try a bounded number of times, then
    // read the boxes as following each other.
    it("a detector that refuses to start is tried once, not in a loop, and the boxes then follow each other", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted", { startRejectsTimes: 50 });
      const { panel } = await mountUnlockedByPin();

      expect(rig.detectors.length).toBeLessThanOrEqual(2);
      hide();
      expect(chatOpen(panel)).toBe(false); // tab off / screen on, no detector: locks at once
    });

    it("does not start a detector without permission, and asks for none itself", async () => {
      rig = installIdleDetector("prompt");
      await mountSettled();
      expect(rig.detectors).toHaveLength(0);
    });

    it("starts the detector once the sheet announces the permission was granted", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      rig = installIdleDetector("prompt");
      const { panel } = await mountUnlockedByPin();
      expect(rig.detectors).toHaveLength(0);

      rig.permission.state = "granted";
      window.dispatchEvent(new Event(LOCK_PREFS_CHANGED_EVENT));
      await flush();
      expect(rig.running()).toHaveLength(1);

      // Now the boxes are read as stored. The device is not proven yet: a real screen lock as it
      // happens proves it (and the ticked screen box locks) ...
      hide();
      rig.lockScreen();
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);
      expect(window.localStorage.getItem(SCREENLOCK_PROVEN_KEY)).toBe("1");
      expect(chatOpen(panel)).toBe(false);

      // ... after which tab off + a proven device restores after a plain tab switch.
      await unlockWithPin(panel);
      await vi.advanceTimersByTimeAsync(5_000);
      hide();
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);
      expect(chatOpen(panel)).toBe(true);
    });

    it("does not restart a RUNNING detector on every settings write (it could drop the events it is there to catch)", async () => {
      rig = installIdleDetector("granted");
      await mountSettled();
      expect(rig.detectors).toHaveLength(1);
      window.dispatchEvent(new Event(LOCK_PREFS_CHANGED_EVENT));
      window.dispatchEvent(new Event(LOCK_PREFS_CHANGED_EVENT));
      await flush();
      expect(rig.detectors).toHaveLength(1);
    });
  });

  describe("the Idle Detection watcher's lifecycle", () => {
    it("starts with the minimum threshold and a signal", async () => {
      rig = installIdleDetector("granted");
      await mountSettled();
      const options = at(rig.detectors, 0).startOptions;
      expect(options?.threshold).toBe(IDLE_DETECTOR_THRESHOLD_MS);
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    });

    it("is stopped (its signal aborted) when the panel is torn down", async () => {
      rig = installIdleDetector("granted");
      const panel = await mountSettled();
      const signal = at(rig.detectors, 0).startOptions?.signal;
      expect(signal?.aborted).toBe(false);
      panel.teardown();
      expect(signal?.aborted).toBe(true);
    });

    it("ignores an 'unlocked' report and a report of no state", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();
      rig.unlockScreen();
      const detector = at(rig.running(), 0);
      detector.screenState = null;
      detector.dispatchEvent(new Event("change"));
      expect(chatOpen(panel)).toBe(true);
    });
  });

  describe("a screen lock while the page stays visible (a desktop Win+L)", () => {
    it.each([
      ["both on", true],
      ["tab off, screen on", true],
      ["tab on, screen off", false],
      ["both off", false],
    ] as const)("%s: locks the open chat: %s", async (name, locks) => {
      applySettings(name);
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();

      rig.lockScreen();

      expect(chatOpen(panel)).toBe(!locks);
    });

    it("pauses an active grant when it locks, and does not when the box is unticked", async () => {
      rig = installIdleDetector("granted");
      await mountUnlockedByGrant();
      rig.lockScreen();
      expect(paused()).toBe(true);

      document.body.innerHTML = "";
      window.localStorage.clear();
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      await mountUnlockedByGrant();
      rig.lockScreen();
      expect(paused()).toBe(false);
    });

    it("does nothing on the decoy", async () => {
      rig = installIdleDetector("granted");
      const panel = await mountSettled();
      rig.lockScreen();
      expect(chatOpen(panel)).toBe(false);
      expect(paused()).toBe(false);
    });

    it("also locks a chat that is fading out", async () => {
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();
      await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS + 10); // fading
      rig.lockScreen();
      expect(chatOpen(panel)).toBe(false);
    });
  });

  describe("a background switch in the states that are not an open chat", () => {
    it("a revealed affordance and an open PIN pad lock on hidden whatever the boxes say", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      const panel = await mountSettled();
      panel.element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      panel.element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(MULTI_TAP_INTERVAL_MS + 1);
      (panel.element.querySelector(".wx-srv-affordance") as HTMLButtonElement).click();
      expect(pinPadShown(panel)).toBe(true);

      hide();

      expect(pinPadShown(panel)).toBe(false);
    });

    it("a chat already fading out locks on hidden immediately, whatever the boxes say", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      const { panel, chat } = await mountUnlockedByPin();
      await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS + 10);
      expect(panel.element.querySelector(".wx-srv-chat-host")?.classList.contains("wx-srv-fading")).toBe(true);

      hide();

      expect(chatOpen(panel)).toBe(false);
      expect(chat.detachCalls).toBe(1);
    });
  });

  describe("R7: a file picker or a mic-permission prompt never lock or shield", () => {
    it.each(["filePicker", "micPermission"] as const)("%s open: no lock, no shield, no pause, whatever the boxes", async (reason) => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel, chat } = await mountUnlockedByGrant();
      const release = requireHooks(chat).suspend(reason);

      hide();
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);

      expect(chatOpen(panel)).toBe(true);
      expect(chat.detachCalls).toBe(0);
      expect(paused()).toBe(false);
      release();
    });

    it("the default (both on) also stays open with a picker open, and locks once it is closed and the page hides again", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      const release = requireHooks(chat).suspend("filePicker");
      hide();
      expect(chatOpen(panel)).toBe(true);
      show();
      release();

      hide();
      expect(chatOpen(panel)).toBe(false);
      expect(paused()).toBe(true);
    });

    it("recording and mediaPlaying suspensions do NOT excuse a background switch", async () => {
      const { panel, chat } = await mountUnlockedByPin();
      requireHooks(chat).suspend("recording");
      requireHooks(chat).suspend("mediaPlaying");
      hide();
      expect(chatOpen(panel)).toBe(false);
    });
  });

  describe("the default settings with a grant", () => {
    it("a background switch locks at once AND pauses the grant (the ticked boxes are a lock the owner asked for)", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      hide();

      expect(chatOpen(panel)).toBe(false);
      expect(chat.detachCalls).toBe(1);
      expect(paused()).toBe(true);

      show();
      panel.teardown();
      document.body.innerHTML = "";
      grantCalls.length = 0;
      const reloaded = await mountSettled();
      expect(grantCalls).toHaveLength(0);
      expect(chatOpen(reloaded)).toBe(false);
    });

    it("both boxes unticked with a grant: the chat survives a background switch, idle, and a long absence", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      const { panel } = await mountUnlockedByGrant();

      hide();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      show();

      expect(chatOpen(panel)).toBe(true);
      expect(paused()).toBe(false);
    });

    it("control: without a grant, default settings lock on hidden and leave no pause key", async () => {
      const { panel } = await mountUnlockedByPin();
      hide();
      expect(chatOpen(panel)).toBe(false);
      expect(window.localStorage.getItem(GRANT_PAUSED_KEY)).toBeNull();
    });
  });

  describe("the page being unloaded (a reload, a navigation, a closing tab)", () => {
    function pageHide(persisted: boolean): void {
      window.dispatchEvent(Object.assign(new Event("pagehide"), { persisted }));
    }

    it("pagehide then hidden neither locks nor pauses the grant — a reload must not undo 'keep this device unlocked'", async () => {
      // Both boxes ticked (the default): an ordinary background switch WOULD lock and pause.
      const { panel, chat } = await mountUnlockedByGrant();
      pageHide(false);
      hide();

      expect(chatOpen(panel)).toBe(true);
      expect(chat.detachCalls).toBe(0);
      expect(paused()).toBe(false);

      // The reloaded page opens straight into the chat, with no PIN.
      show();
      panel.teardown();
      document.body.innerHTML = "";
      grantCalls.length = 0;
      const reloaded = await mountSettled();
      expect(grantCalls).toHaveLength(1);
      expect(chatOpen(reloaded)).toBe(true);
    });

    it("a page entering the back/forward cache (persisted) is an ordinary background switch: it locks and pauses", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      pageHide(true);
      hide();

      expect(chatOpen(panel)).toBe(false);
      expect(chat.detachCalls).toBe(1);
      expect(paused()).toBe(true);
    });

    it("pageshow ends the unload: a later background switch locks as usual", async () => {
      const { panel } = await mountUnlockedByGrant();
      pageHide(false);
      window.dispatchEvent(new Event("pageshow"));
      hide();

      expect(chatOpen(panel)).toBe(false);
      expect(paused()).toBe(true);
    });

    it("an unload with no grant leaves the chat alone too (it is about to be discarded), and never writes a pause", async () => {
      const { panel } = await mountUnlockedByPin();
      pageHide(false);
      hide();

      expect(chatOpen(panel)).toBe(true);
      expect(window.localStorage.getItem(GRANT_PAUSED_KEY)).toBeNull();
    });

    it("the unload rule covers the shield too: with the boxes differing, an unload never shields", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      const { panel, chat } = await mountUnlockedByGrant();
      pageHide(false);
      hide();

      expect(chatOpen(panel)).toBe(true);
      expect(chat.detachCalls).toBe(0);
    });
  });

  describe("idle that ran out while the page was in the background", () => {
    it("with both boxes unticked and no grant, a return after the idle period locks instead of waiting for a timer that never fired", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      const { panel } = await mountUnlockedByPin();
      hide();
      expect(chatOpen(panel)).toBe(true);
      // A sleeping phone: the wall clock moves on, the timers do not fire.
      vi.setSystemTime(Date.now() + 60_000);

      show();
      await vi.advanceTimersByTimeAsync(FADE_MS + 10);

      expect(chatOpen(panel)).toBe(false);
    });

    it("a return BEFORE the idle period ran out changes nothing", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      const { panel } = await mountUnlockedByPin();
      hide();
      vi.setSystemTime(Date.now() + 3_000);
      show();
      expect(chatOpen(panel)).toBe(true);
    });

    it("an active grant excuses it", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      const { panel } = await mountUnlockedByGrant();
      hide();
      vi.setSystemTime(Date.now() + 60_000);
      show();
      await vi.advanceTimersByTimeAsync(FADE_MS + 10);
      expect(chatOpen(panel)).toBe(true);
    });

    it("a suspension holding the idle timer paused (a playing video) excuses it too", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      const { panel, chat } = await mountUnlockedByPin();
      requireHooks(chat).suspend("mediaPlaying");
      hide();
      vi.setSystemTime(Date.now() + 60_000);
      show();
      await vi.advanceTimersByTimeAsync(FADE_MS + 10);
      expect(chatOpen(panel)).toBe(true);
    });

    it("the same check stops a shield from restoring a chat that has gone idle", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();
      hide();
      vi.setSystemTime(Date.now() + 60_000);

      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);

      expect(chatOpen(panel)).toBe(false);
    });

    it("with an active grant the same shield DOES restore after a long absence", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByGrant();
      hide();
      vi.setSystemTime(Date.now() + 60_000);

      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);

      expect(chatOpen(panel)).toBe(true);
    });

    it("a return with the default settings (locked at hide) does nothing more", async () => {
      const { panel, chat } = await mountUnlockedByPin();
      hide();
      vi.setSystemTime(Date.now() + 60_000);
      show();
      await vi.advanceTimersByTimeAsync(FADE_MS + 10);
      expect(chatOpen(panel)).toBe(false);
      expect(chat.detachCalls).toBe(1);
    });
  });

  describe("what the panel holds after a lock, and when the grant is switched on late", () => {
    it("the chat view's session accessor is null after a lock: the token does not linger in memory", async () => {
      storeGrant();
      const chat = trackedChatViewFactory();
      let accessor: (() => ServerSession | null) | null = null;
      const panel = await mountSettled({
        createServerChatView: (deps) => {
          accessor = deps.session;
          return chat.createServerChatView(deps);
        },
      });
      expect(chatOpen(panel)).toBe(true);
      expect(accessor).not.toBeNull();
      expect((accessor as unknown as () => ServerSession | null)()?.token).toBe("grant-tok-1");

      requireHooks(chat).lockNow("panic");

      expect(chatOpen(panel)).toBe(false);
      expect((accessor as unknown as () => ServerSession | null)()).toBeNull();
    });

    it("a renewal that lands after a lock never resurrects the session or re-arms its timers", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      const late = deferred<Response>();
      grantAnswers.push(() => late.promise);
      await vi.advanceTimersByTimeAsync(RENEW_AT_MS + 1);
      expect(grantCalls).toHaveLength(2); // the mount's unlock and the renewal now in flight

      // A lock that does not pause the grant (a 401 would renew instead), while it is out.
      requireHooks(chat).lockNow("expired");
      expect(chatOpen(panel)).toBe(false);
      late.resolve(jsonResponse({ token: "late-token", expiresAt: expiresIn(TOKEN_LIFETIME_S) }));
      await flush();

      // Had the late answer been adopted, its renewal timer would fire and mint again.
      await vi.advanceTimersByTimeAsync(2 * TOKEN_LIFETIME_S * 1000);
      expect(grantCalls).toHaveLength(2);
      expect(chatOpen(panel)).toBe(false);
      expect(chat.attachCalls.map((session) => session.token)).not.toContain("late-token");
    });

    it("switching the grant on while the token is already inside its renewal window renews at once", async () => {
      const { chat } = await mountUnlockedByPin();
      // Keep the idle timer out of the way so the chat stays open for the whole token life.
      requireHooks(chat).suspend("recording");
      await vi.advanceTimersByTimeAsync(RENEW_AT_MS + 60_000);
      expect(grantCalls).toHaveLength(0); // the early renewal fired with no grant: a no-op

      storeGrant();
      window.dispatchEvent(new Event("wx-srv-grant-state-changed"));
      await vi.advanceTimersByTimeAsync(1); // the re-armed renewal is already due (a 0 ms timer)
      await flush();

      expect(grantCalls).toHaveLength(1);
      expect(lastAttach(chat).token).toBe("grant-tok-1");
    });
  });

  describe("the cause of a hide is judged from WHEN the lock event was dispatched (Architect ruling, §8)", () => {
    it("the ruling's scenario: switch app, the phone auto-locks 30 s later, return -> locked, tab ON / screen OFF", async () => {
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();

      hide();
      await vi.advanceTimersByTimeAsync(30_000);
      rig.lockScreen();
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);

      expect(chatOpen(panel)).toBe(false);
    });

    it("the same absence on a PROVEN device with tab OFF / screen ON: the late event makes it ambiguous, so locked", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();

      hide();
      await vi.advanceTimersByTimeAsync(30_000);
      rig.lockScreen();
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);

      expect(chatOpen(panel)).toBe(false);
    });

    it("a lock event 1.5 s after the hide is the cause: a screen lock, so tab ON / screen OFF restores, and the device is proven", async () => {
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();

      hide();
      await vi.advanceTimersByTimeAsync(1_500);
      rig.lockScreen();
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);

      expect(chatOpen(panel)).toBe(true);
      expect(window.localStorage.getItem(SCREENLOCK_PROVEN_KEY)).toBe("1");
    });

    it("a lock event 0.8 s BEFORE the hide is the cause too (a device may report it just ahead of the page hiding)", async () => {
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();

      rig.lockScreen(); // still visible, and the (unticked) screen box ignores it
      expect(chatOpen(panel)).toBe(true);
      await vi.advanceTimersByTimeAsync(800);
      hide();
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);

      expect(chatOpen(panel)).toBe(true);
      expect(window.localStorage.getItem(SCREENLOCK_PROVEN_KEY)).toBe("1");
    });

    it("a lock event 1.5 s before the hide is too old to explain it: nothing is seen, the device is unproven, so locked", async () => {
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();

      rig.lockScreen();
      await vi.advanceTimersByTimeAsync(1_500);
      hide();
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);

      expect(chatOpen(panel)).toBe(false);
      expect(window.localStorage.getItem(SCREENLOCK_PROVEN_KEY)).toBeNull();
    });

    it("a lock event batched at return (after a long absence) is ambiguous, so locked", async () => {
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();

      hide();
      await vi.advanceTimersByTimeAsync(10_000);
      show();
      rig.lockScreen(); // delivered as the frozen page resumes
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);

      expect(chatOpen(panel)).toBe(false);
    });

    it("a PROVEN device with no event at all reads the hide as a tab change, so tab OFF / screen ON restores", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();

      hide();
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);

      expect(chatOpen(panel)).toBe(true);
    });

    it("a PROVEN device with a BATCHED event is ambiguous, not a tab change: locked", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();

      hide();
      await vi.advanceTimersByTimeAsync(10_000);
      show();
      rig.lockScreen();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);

      expect(chatOpen(panel)).toBe(false);
    });

    it("the proof is set by an in-window event and NOT by a batched one", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByPin();

      hide();
      await vi.advanceTimersByTimeAsync(10_000);
      rig.lockScreen(); // dispatched long after the hide: says nothing about why it hid
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);
      expect(window.localStorage.getItem(SCREENLOCK_PROVEN_KEY)).toBeNull();

      await unlockWithPin(panel);
      await vi.advanceTimersByTimeAsync(5_000);
      hide();
      await vi.advanceTimersByTimeAsync(500);
      rig.lockScreen(); // half a second after the hide: reported as it happened
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);
      expect(window.localStorage.getItem(SCREENLOCK_PROVEN_KEY)).toBe("1");
    });

    it("a stale proof is cleared when there is no detector to have earned it (permission not granted)", async () => {
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("prompt");
      await mountSettled();
      expect(window.localStorage.getItem(SCREENLOCK_PROVEN_KEY)).toBeNull();
    });

    it("a stale proof is cleared in a browser with no Idle Detection API at all", async () => {
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      await mountSettled();
      expect(window.localStorage.getItem(SCREENLOCK_PROVEN_KEY)).toBeNull();
    });
  });

  describe("regressions from the independent review", () => {
    function expiredTokenWithRenewalInFlight(): {
      pending: ReturnType<typeof deferred<Response>>;
    } {
      const pending = deferred<Response>();
      grantAnswers.push(() => pending.promise);
      return { pending };
    }

    it("a SECOND switch while a restore waits for a renewal voids it: the renewal landing while away restores nothing", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByGrant();
      const { pending } = expiredTokenWithRenewalInFlight();
      hide();
      await vi.advanceTimersByTimeAsync(TOKEN_LIFETIME_S * 1000 + MARGIN_MS);
      vi.setSystemTime(Date.now() + MARGIN_MS);
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1); // restore decided, waiting for a token
      await flush();

      hide(); // away again
      pending.resolve(jsonResponse({ token: "renewed", expiresAt: expiresIn(TOKEN_LIFETIME_S) }));
      await flush();
      expect(chatOpen(panel)).toBe(false); // not restored behind the owner's back

      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);
      expect(chatOpen(panel)).toBe(false);
      expect(paused()).toBe(true);
    });

    it("a screen lock while a restore waits for a renewal voids it and locks", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      rig = installIdleDetector("granted");
      const { panel } = await mountUnlockedByGrant();
      const { pending } = expiredTokenWithRenewalInFlight();
      hide();
      await vi.advanceTimersByTimeAsync(TOKEN_LIFETIME_S * 1000 + MARGIN_MS);
      vi.setSystemTime(Date.now() + MARGIN_MS);
      show();
      await vi.advanceTimersByTimeAsync(SHIELD_WAIT_MS + 1);
      await flush();

      rig.lockScreen();
      pending.resolve(jsonResponse({ token: "renewed", expiresAt: expiresIn(TOKEN_LIFETIME_S) }));
      await flush();

      expect(chatOpen(panel)).toBe(false);
      expect(paused()).toBe(true);
    });

    it("an idle period that ran out while the page was away locks INSTANTLY: a touch on return cannot bring it back", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      const { panel } = await mountUnlockedByPin();

      hide(); // both boxes off: nothing locks, the idle timer keeps counting
      vi.setSystemTime(Date.now() + 60_000); // a suspended page: the clock moved, no timer ran
      show();
      expect(chatOpen(panel)).toBe(false);

      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
      document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await flush();
      expect(chatOpen(panel)).toBe(false);
    });

    it("an idle fade that began while the page was away is finished on return, not left for a touch to cancel", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      const { panel } = await mountUnlockedByPin();

      hide();
      await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS + 100); // idle fired while away: fading, fade timer pending
      expect(panel.element.querySelector(".wx-srv-chat-host")?.classList.contains("wx-srv-fading")).toBe(true);

      show();
      expect(chatOpen(panel)).toBe(false);
    });

    it("a 401 from unlock-with-grant that is NOT grant_invalid (the admin's own gate) never makes the device forget its grant", async () => {
      storeGrant();
      grantAnswers.push(() => jsonResponse({ error: "unauthorized" }, 401));

      const panel = await mountSettled();

      expect(chatOpen(panel)).toBe(false); // the decoy and the PIN flow
      expect(window.localStorage.getItem(DEVICE_GRANT_KEY)).not.toBeNull();
    });

    it("the same 401 on a renewal keeps the grant and the open chat, and retries", async () => {
      const { panel } = await mountUnlockedByGrant();
      grantAnswers.push(() => jsonResponse({ error: "unauthorized" }, 401));

      await vi.advanceTimersByTimeAsync(RENEW_AT_MS + 1);
      await flush();

      expect(window.localStorage.getItem(DEVICE_GRANT_KEY)).not.toBeNull();
      expect(chatOpen(panel)).toBe(true);
      await vi.advanceTimersByTimeAsync(GRANT_RENEW_RETRY_MS + 1);
      await flush();
      expect(grantCalls).toHaveLength(3); // mount, the refused renewal, the retry
    });

    it("a renewal still in flight when the panel is torn down never re-attaches the disposed chat or re-arms a timer", async () => {
      const { panel, chat } = await mountUnlockedByGrant();
      const { pending } = expiredTokenWithRenewalInFlight();
      await vi.advanceTimersByTimeAsync(RENEW_AT_MS + 1);
      expect(grantCalls).toHaveLength(2);

      panel.teardown();
      const attachesBefore = chat.attachCalls.length;
      pending.resolve(jsonResponse({ token: "late", expiresAt: expiresIn(TOKEN_LIFETIME_S) }));
      await flush();

      expect(chat.attachCalls).toHaveLength(attachesBefore);
      await vi.advanceTimersByTimeAsync(3 * TOKEN_LIFETIME_S * 1000);
      expect(grantCalls).toHaveLength(2); // a dead panel does not keep renewing (or keep the grant fresh)
    });

    it("the token is not kept after a teardown with a grant active", async () => {
      storeGrant();
      const chat = trackedChatViewFactory();
      let accessor: (() => ServerSession | null) | null = null;
      const panel = await mountSettled({
        createServerChatView: (deps) => {
          accessor = deps.session;
          return chat.createServerChatView(deps);
        },
      });
      expect((accessor as unknown as () => ServerSession | null)()).not.toBeNull();

      panel.teardown();

      expect((accessor as unknown as () => ServerSession | null)()).toBeNull();
    });

    it("a hide while the grant unlock is still answering drops it, and the return tries again (without pausing the grant)", async () => {
      storeGrant();
      const answer = deferred<Response>();
      grantAnswers.push(() => answer.promise);
      const panel = mount();
      await flush();
      expect(granting(panel)).toBe(true);

      hide();
      expect(granting(panel)).toBe(false);
      expect(paused()).toBe(false);
      answer.resolve(jsonResponse({ token: "dropped", expiresAt: expiresIn(TOKEN_LIFETIME_S) }));
      await flush();
      expect(chatOpen(panel)).toBe(false); // the late answer is not adopted

      show();
      await flush();

      expect(grantCalls).toHaveLength(2);
      expect(chatOpen(panel)).toBe(true);
    });
  });

  describe("teardown", () => {
    it("leaves no timer running: nothing fires after a panel with a grant is torn down", async () => {
      const { panel } = await mountUnlockedByGrant();
      panel.teardown();
      const before = grantCalls.length;
      await vi.advanceTimersByTimeAsync(TOKEN_LIFETIME_S * 1000 * 2);
      await flush();
      expect(grantCalls).toHaveLength(before);
    });

    it("removes the visibility listener: a hide after teardown does not touch the torn-down panel's grant", async () => {
      const { panel } = await mountUnlockedByGrant();
      panel.teardown();
      hide();
      expect(paused()).toBe(false);
    });
  });
});
