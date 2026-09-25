// The settings sheet's per-device lock preferences (spec/server-chat/03-permanent-unlock.md):
// "Keep this device unlocked" with its inline PIN pad and "Sign out other devices" (§4), the
// auto-lock row that greys out while a grant exists, and the two "Lock when I…" checkboxes
// with their Idle Detection permission dance (§8). Real DOM, real localStorage, a mocked
// network boundary and a fake IdleDetector.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  clearDeviceGrant,
  DEVICE_GRANT_KEY,
  deviceLabel,
  GRANT_PAUSED_KEY,
  GRANT_STATE_CHANGED_EVENT,
  storeDeviceGrant,
  type StoredDeviceGrant,
} from "../../src/server/deviceGrant";
import { isExcludedTapTarget } from "../../src/server/gestures";
import type { ServerIdentity } from "../../src/server/identity";
import {
  LOCK_ON_SCREEN_KEY,
  LOCK_ON_TAB_KEY,
  LOCK_PREFS_CHANGED_EVENT,
  SCREENLOCK_PROVEN_KEY,
  setLockSettings,
  setScreenLockProven,
} from "../../src/server/lockSettings";
import { mountServerSettingsSheet } from "../../src/server/settingsSheet";
import type { LockHooks, ServerSession } from "../../src/server/types";

const { getUsage } = vi.hoisted(() => ({ getUsage: vi.fn() }));
vi.mock("../../src/server/api/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/api/messages")>()),
  getUsage,
}));

const SESSION: ServerSession = { token: "tok-123", expiresAt: 9_999_999_999 };
const GRANT: StoredDeviceGrant = { grantId: "0123456789abcdef0123456789abcdef", secret: "S".repeat(43) };
const PIN = "482913";

const MIRROR_NOTE = "This browser can't tell a screen lock from a tab switch, so both follow 'Lock when I change tab'.";
const PROOF_NOTE =
  "Lock your screen once so this phone can learn to tell a screen lock from a tab switch — until then, switching away also locks.";

type View = ReturnType<typeof mountServerSettingsSheet>;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function created(grant: StoredDeviceGrant = GRANT): Response {
  return jsonResponse({ grantId: grant.grantId, secret: grant.secret, token: "fresh", expiresAt: 9_999_999_999 }, 201);
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function q<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
}

function identity(): ServerIdentity {
  return { getName: () => "Josh", setName: vi.fn(), getDeviceId: () => "device-1", isMine: () => true };
}

function makeHooks(): LockHooks {
  return { suspend: vi.fn(() => () => {}), lockNow: vi.fn() };
}

// -- A fake IdleDetector + permission API --------------------------------------------------

type PermissionValue = "granted" | "denied" | "prompt";

interface FakeDetectorEnv {
  readonly requestPermission: Mock<() => Promise<"granted" | "denied">>;
  readonly query: Mock<() => Promise<unknown>>;
  setPermission(state: PermissionValue): void;
}

function installIdleDetector(
  state: PermissionValue,
  requestPermission: () => Promise<"granted" | "denied"> = () => Promise.resolve("granted"),
): FakeDetectorEnv {
  const status = Object.assign(new EventTarget(), { state });
  const query = vi.fn(() => Promise.resolve(status));
  Object.defineProperty(navigator, "permissions", { configurable: true, value: { query } });
  const request = vi.fn<() => Promise<"granted" | "denied">>(requestPermission);
  class FakeIdleDetector extends EventTarget {
    static requestPermission = request;
  }
  Object.defineProperty(window, "IdleDetector", { configurable: true, writable: true, value: FakeIdleDetector });
  return {
    requestPermission: request,
    query,
    setPermission(next: PermissionValue): void {
      status.state = next;
    },
  };
}

function uninstallIdleDetector(): void {
  Reflect.deleteProperty(window, "IdleDetector");
  Reflect.deleteProperty(navigator, "permissions");
}

/** The sheet asks the permission API as soon as it opens, but only APPLIES the answer a moment
 * later. `query` being called is therefore not enough: wait one macrotask for the result to land. */
async function statusApplied(detector: FakeDetectorEnv): Promise<void> {
  await vi.waitFor(() => expect(detector.query).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("settings sheet — per-device lock preferences", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let mounted: View[] = [];
  let hooks: LockHooks;
  let session: ServerSession | null;

  beforeEach(() => {
    vi.useRealTimers();
    getUsage.mockReset().mockResolvedValue({
      mediaAvailable: true,
      usedBytes: 0,
      quotaBytes: 10,
      freeBytes: 10,
      erasurePending: false,
    });
    fetchMock = vi.fn().mockRejectedValue(new Error("unexpected fetch"));
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.clear();
    hooks = makeHooks();
    session = SESSION;
    mounted = [];
  });

  afterEach(() => {
    for (const view of mounted) view.teardown();
    uninstallIdleDetector();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.localStorage.clear();
    document.body.innerHTML = "";
  });

  function mountSheet(): View {
    const view = mountServerSettingsSheet({
      identity: identity(),
      hooks,
      win: window,
      getSession: () => session,
      onWipe: vi.fn(),
      onNameChanged: vi.fn(),
      onClose: vi.fn(),
    });
    document.body.appendChild(view.element);
    mounted.push(view);
    return view;
  }

  function openSheet(): View {
    const view = mountSheet();
    view.open();
    return view;
  }

  const stored = (key: string): string | null => window.localStorage.getItem(key);

  // -- element helpers --
  const keepInput = (v: View) => q<HTMLInputElement>(v.element, ".wx-srv-sheet-keep-input");
  const keepNote = (v: View) => q<HTMLElement>(v.element, ".wx-srv-sheet-keep-note");
  const keepPadHost = (v: View) => q<HTMLElement>(v.element, ".wx-srv-sheet-keep-pad");
  const padMessage = (v: View) => q<HTMLElement>(keepPadHost(v), ".wx-srv-pinpad-message");
  const idleInput = (v: View) => q<HTMLInputElement>(v.element, 'input[type="checkbox"]');
  const idleLabel = (v: View) => q<HTMLLabelElement>(v.element, ".wx-srv-sheet-idle-row");
  const idleNote = (v: View) => q<HTMLElement>(v.element, ".wx-srv-sheet-idle-note");
  const signOutButton = (v: View) => q<HTMLButtonElement>(v.element, ".wx-srv-sheet-signout");
  const signOutStatus = (v: View) => q<HTMLElement>(v.element, ".wx-srv-sheet-signout-status");
  const tabInput = (v: View) => q<HTMLInputElement>(v.element, ".wx-srv-sheet-locktab-input");
  const screenInput = (v: View) => q<HTMLInputElement>(v.element, ".wx-srv-sheet-lockscreen-input");
  const screenRow = (v: View) => q<HTMLElement>(v.element, ".wx-srv-sheet-lockscreen-row");
  const lockNote = (v: View) => q<HTMLElement>(v.element, ".wx-srv-sheet-lockprefs-note");

  function padKey(v: View, label: string): HTMLButtonElement {
    const key = Array.from(keepPadHost(v).querySelectorAll<HTMLButtonElement>(".wx-srv-pinpad-key")).find(
      (button) => button.textContent === label,
    );
    if (key === undefined) throw new Error(`no pin pad key ${label}`);
    return key;
  }

  function enterPin(v: View, pin: string): void {
    for (const digit of pin) padKey(v, digit).click();
    padKey(v, "✓").click();
  }

  function lastFetch(): { readonly url: string; readonly init: RequestInit; readonly headers: Headers } {
    const call = fetchMock.mock.calls.at(-1);
    if (call === undefined) throw new Error("fetch was not called");
    const init = call[1] as RequestInit;
    return { url: String(call[0]), init, headers: init.headers as Headers };
  }

  function expectGuardAndToken(headers: Headers): void {
    expect(headers.get("X-Wixy-Server-Unlock")).toBe("1");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Wixy-Server-Token")).toBe(SESSION.token);
  }

  function seedGrant(extra: Record<string, string> = {}): void {
    window.localStorage.setItem(DEVICE_GRANT_KEY, JSON.stringify(GRANT));
    for (const [key, value] of Object.entries(extra)) window.localStorage.setItem(key, value);
  }

  // ===========================================================================================
  describe("Keep this device unlocked — turning it on", () => {
    it("starts unticked, with no note, the pad closed and nothing stored", () => {
      const view = openSheet();
      expect(keepInput(view).checked).toBe(false);
      expect(keepNote(view).hidden).toBe(true);
      expect(keepPadHost(view).hidden).toBe(true);
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
    });

    it("ticking opens the inline PIN pad and stores nothing until the server says yes", () => {
      const view = openSheet();
      keepInput(view).click();

      expect(keepPadHost(view).hidden).toBe(false);
      expect(q(keepPadHost(view), ".wx-srv-pinpad-title").textContent).toBe("Enter PIN to keep this device unlocked");
      expect(keepInput(view).checked).toBe(true);
      expect(keepNote(view).hidden).toBe(true);
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      // Nothing is on yet, so the auto-lock row still works.
      expect(idleInput(view).disabled).toBe(false);
    });

    it("marks the pad gesture-exempt so tapping digits quickly can never trip the multi-tap lock", () => {
      const view = openSheet();
      keepInput(view).click();
      const pad = q<HTMLElement>(keepPadHost(view), ".wx-srv-pinpad");
      expect(pad.hasAttribute("data-srv-gesture-exempt")).toBe(true);
      expect(isExcludedTapTarget(padKey(view, "1"))).toBe(true);
      expect(isExcludedTapTarget(padKey(view, "✓"))).toBe(true);
    });

    it("a correct PIN stores the grant, closes the pad and shows the On note", async () => {
      fetchMock.mockResolvedValueOnce(created());
      const announcements = vi.fn();
      window.addEventListener(GRANT_STATE_CHANGED_EVENT, announcements);
      const view = openSheet();
      keepInput(view).click();
      enterPin(view, PIN);

      await vi.waitFor(() => expect(stored(DEVICE_GRANT_KEY)).not.toBeNull());
      expect(JSON.parse(stored(DEVICE_GRANT_KEY) ?? "null")).toEqual(GRANT);
      expect(keepPadHost(view).hidden).toBe(true);
      expect(keepInput(view).checked).toBe(true);
      expect(keepNote(view).hidden).toBe(false);
      expect(keepNote(view).textContent).toBe("On · Lock with the ✕ or a double-tap");
      expect(announcements).toHaveBeenCalled();
      expect(hooks.lockNow).not.toHaveBeenCalled();
      window.removeEventListener(GRANT_STATE_CHANGED_EVENT, announcements);
    });

    it("sends the PIN and this device's label with the guard headers and the token header", async () => {
      fetchMock.mockResolvedValueOnce(created());
      const view = openSheet();
      keepInput(view).click();
      enterPin(view, PIN);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      const { url, init, headers } = lastFetch();
      expect(url).toBe("/api/admin/server/device-grants");
      expect(init.method).toBe("POST");
      expectGuardAndToken(headers);
      expect(JSON.parse(String(init.body))).toEqual({ pin: PIN, label: deviceLabel(window) });
      expect(url).not.toContain(SESSION.token);
    });

    it("a correct PIN also clears any stale pause and switches the auto-lock row off", async () => {
      window.localStorage.setItem(GRANT_PAUSED_KEY, "1");
      fetchMock.mockResolvedValueOnce(created());
      const view = openSheet();
      keepInput(view).click();
      enterPin(view, PIN);
      await vi.waitFor(() => expect(stored(DEVICE_GRANT_KEY)).not.toBeNull());
      expect(stored(GRANT_PAUSED_KEY)).toBeNull();
      expect(idleInput(view).disabled).toBe(true);
      expect(idleLabel(view).classList.contains("wx-srv-sheet-row-disabled")).toBe(true);
    });

    it("a wrong PIN shows the attempts left, stores nothing and keeps the pad open for a retry", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "wrong_pin", attemptsLeft: 2 }, 401));
      const view = openSheet();
      keepInput(view).click();
      enterPin(view, "000000");

      await vi.waitFor(() => expect(padMessage(view).textContent).toBe("Wrong PIN — 2 attempts left"));
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
      expect(keepPadHost(view).hidden).toBe(false);
      expect(keepInput(view).checked).toBe(true);
      expect(keepNote(view).hidden).toBe(true);
      expect(hooks.lockNow).not.toHaveBeenCalled();

      fetchMock.mockResolvedValueOnce(created());
      enterPin(view, PIN);
      await vi.waitFor(() => expect(stored(DEVICE_GRANT_KEY)).not.toBeNull());
      expect(keepPadHost(view).hidden).toBe(true);
    });

    it("counts down a lockout and holds the keys until it ends", async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "locked_out", retryAfterS: 30 }, 429));
      const view = openSheet();
      keepInput(view).click();
      enterPin(view, PIN);

      await vi.waitFor(() => expect(padMessage(view).textContent).toMatch(/^Too many wrong tries\. Try again in \d+ seconds?\.$/));
      expect(padMessage(view).textContent).toMatch(/in (?:29|30) seconds\./);
      for (const key of keepPadHost(view).querySelectorAll<HTMLButtonElement>(".wx-srv-pinpad-key")) {
        expect(key.disabled).toBe(true);
      }
      vi.advanceTimersByTime(10_000);
      expect(padMessage(view).textContent).toMatch(/in (?:19|20) seconds\./);
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("says 'Please try again.' when the PIN changed mid-check", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "pin_changed" }, 409));
      const view = openSheet();
      keepInput(view).click();
      enterPin(view, PIN);
      await vi.waitFor(() => expect(padMessage(view).textContent).toBe("Please try again."));
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
    });

    it("says the settings are unavailable when the PIN service is down (503)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "pin_service_unavailable" }, 503));
      const view = openSheet();
      keepInput(view).click();
      enterPin(view, PIN);
      await vi.waitFor(() => expect(padMessage(view).textContent).toBe("Server settings unavailable."));
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
      expect(keepPadHost(view).hidden).toBe(false);
    });

    it("says the settings are unavailable when the network fails", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      const view = openSheet();
      keepInput(view).click();
      enterPin(view, PIN);
      await vi.waitFor(() => expect(padMessage(view).textContent).toBe("Server settings unavailable."));
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
    });

    it("uses the generic retry copy for a rejected request (422)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "invalid_pin" }, 422));
      const view = openSheet();
      keepInput(view).click();
      enterPin(view, PIN);
      await vi.waitFor(() => expect(padMessage(view).textContent).toBe("Couldn't unlock — try again."));
    });

    it("uses the generic retry copy for a 201 it cannot read", async () => {
      fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 201 }));
      const view = openSheet();
      keepInput(view).click();
      enterPin(view, PIN);
      await vi.waitFor(() => expect(padMessage(view).textContent).toBe("Couldn't unlock — try again."));
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
    });

    it("locks the chat when the server says it is locked (401 {error: locked})", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "locked" }, 401));
      const view = openSheet();
      keepInput(view).click();
      enterPin(view, PIN);
      await vi.waitFor(() => expect(hooks.lockNow).toHaveBeenCalledWith("unauthorized"));
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
    });

    it("Cancel closes the pad, unticks the box and stores nothing", () => {
      const view = openSheet();
      keepInput(view).click();
      q<HTMLButtonElement>(keepPadHost(view), ".wx-srv-pinpad-cancel").click();
      expect(keepPadHost(view).hidden).toBe(true);
      expect(keepInput(view).checked).toBe(false);
      expect(keepNote(view).hidden).toBe(true);
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("unticking the box while the pad is open aborts the same way", () => {
      const view = openSheet();
      keepInput(view).click();
      keepInput(view).click();
      expect(keepPadHost(view).hidden).toBe(true);
      expect(keepInput(view).checked).toBe(false);
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("closing the sheet with the pad open aborts, and reopening shows a fresh, unticked row", () => {
      const view = openSheet();
      keepInput(view).click();
      padKey(view, "1").click();
      view.close();
      expect(keepPadHost(view).hidden).toBe(true);
      view.open();
      expect(keepInput(view).checked).toBe(false);
      expect(keepPadHost(view).hidden).toBe(true);
      keepInput(view).click();
      expect(keepPadHost(view).querySelectorAll(".wx-srv-pinpad-dot")).toHaveLength(0);
    });

    it("ignores a response that arrives after the owner cancelled", async () => {
      const pending = deferred<Response>();
      fetchMock.mockReturnValueOnce(pending.promise);
      const view = openSheet();
      keepInput(view).click();
      enterPin(view, PIN);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      q<HTMLButtonElement>(keepPadHost(view), ".wx-srv-pinpad-cancel").click();
      pending.resolve(created());
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
      expect(keepInput(view).checked).toBe(false);
      expect(keepPadHost(view).hidden).toBe(true);
      expect(keepNote(view).hidden).toBe(true);
    });

    it("ignores a response that arrives after the sheet was closed", async () => {
      const pending = deferred<Response>();
      fetchMock.mockReturnValueOnce(pending.promise);
      const view = openSheet();
      keepInput(view).click();
      enterPin(view, PIN);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      view.close();
      pending.resolve(created());
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
      expect(idleInput(view).disabled).toBe(false);
    });

    it("revokes the orphaned server grant when a cancelled enrolment's request succeeds anyway", async () => {
      const pending = deferred<Response>();
      fetchMock.mockReturnValueOnce(pending.promise);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      const view = openSheet();
      keepInput(view).click();
      enterPin(view, PIN);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      q<HTMLButtonElement>(keepPadHost(view), ".wx-srv-pinpad-cancel").click();
      pending.resolve(created());
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      // Nothing was stored on this device, so the server must not keep a grant no device holds.
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
      const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(url).toBe(`/api/admin/server/device-grants/${GRANT.grantId}`);
      expect(init.method).toBe("DELETE");
    });

    it("closes the pad without asking the server when the chat has no session any more", () => {
      const view = openSheet();
      keepInput(view).click();
      session = null;
      enterPin(view, PIN);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(keepPadHost(view).hidden).toBe(true);
      expect(keepInput(view).checked).toBe(false);
    });

    it("revokes the server's grant and says so when the browser will not keep it", async () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string) => {
        if (key === DEVICE_GRANT_KEY) throw new Error("QuotaExceededError");
      });
      fetchMock.mockResolvedValueOnce(created()).mockResolvedValueOnce(noContent());
      const view = openSheet();
      keepInput(view).click();
      enterPin(view, PIN);

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const { url, init, headers } = lastFetch();
      expect(url).toBe(`/api/admin/server/device-grants/${GRANT.grantId}`);
      expect(init.method).toBe("DELETE");
      expectGuardAndToken(headers);
      await vi.waitFor(() => expect(padMessage(view).textContent).toBe("Couldn't unlock — try again."));
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
      expect(keepInput(view).checked).toBe(true);
      expect(keepPadHost(view).hidden).toBe(false);
      expect(keepNote(view).hidden).toBe(true);
    });

    it("survives that cleanup request failing too", async () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string) => {
        if (key === DEVICE_GRANT_KEY) throw new Error("QuotaExceededError");
      });
      fetchMock.mockResolvedValueOnce(created()).mockRejectedValueOnce(new TypeError("offline"));
      const view = openSheet();
      keepInput(view).click();
      enterPin(view, PIN);
      await vi.waitFor(() => expect(padMessage(view).textContent).toBe("Couldn't unlock — try again."));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not let an outside grant-state change untick the box while the pad is open", () => {
      const view = openSheet();
      keepInput(view).click();
      clearDeviceGrant(window);
      expect(keepInput(view).checked).toBe(true);
      expect(keepPadHost(view).hidden).toBe(false);
    });
  });

  // ===========================================================================================
  describe("Keep this device unlocked — an existing grant", () => {
    it("opens ticked with the On note, the pad closed, and the auto-lock row greyed out", () => {
      seedGrant();
      const view = openSheet();
      expect(keepInput(view).checked).toBe(true);
      expect(keepNote(view).hidden).toBe(false);
      expect(keepNote(view).textContent).toBe("On · Lock with the ✕ or a double-tap");
      expect(keepPadHost(view).hidden).toBe(true);
      expect(idleInput(view).disabled).toBe(true);
      expect(idleLabel(view).classList.contains("wx-srv-sheet-row-disabled")).toBe(true);
      expect(idleNote(view).hidden).toBe(false);
      expect(idleNote(view).textContent).toBe("Off — nothing to extend while this device is kept unlocked.");
    });

    it("a paused grant still counts as on — the setting is on, only the unlocking is paused", () => {
      seedGrant({ [GRANT_PAUSED_KEY]: "1" });
      const view = openSheet();
      expect(keepInput(view).checked).toBe(true);
      expect(idleInput(view).disabled).toBe(true);
    });

    it("leaves the auto-lock row alone when there is no grant", () => {
      const view = openSheet();
      expect(idleInput(view).disabled).toBe(false);
      expect(idleLabel(view).classList.contains("wx-srv-sheet-row-disabled")).toBe(false);
      expect(idleNote(view).hidden).toBe(true);
    });

    it("a malformed stored grant reads as off", () => {
      window.localStorage.setItem(DEVICE_GRANT_KEY, "{\"grantId\": \"nope\"}");
      const view = openSheet();
      expect(keepInput(view).checked).toBe(false);
      expect(idleInput(view).disabled).toBe(false);
    });

    it("follows the grant being turned on or off elsewhere while the sheet is open", () => {
      const view = openSheet();
      expect(keepInput(view).checked).toBe(false);
      storeDeviceGrant(window, GRANT);
      expect(keepInput(view).checked).toBe(true);
      expect(keepNote(view).hidden).toBe(false);
      expect(idleInput(view).disabled).toBe(true);
      expect(idleNote(view).hidden).toBe(false);
      clearDeviceGrant(window);
      expect(keepInput(view).checked).toBe(false);
      expect(keepNote(view).hidden).toBe(true);
      expect(idleInput(view).disabled).toBe(false);
      expect(idleNote(view).hidden).toBe(true);
    });
  });

  // ===========================================================================================
  describe("accessibility — describedby and live-region wiring (reviewer finding, round 2)", () => {
    it("keepNote is a live region and the keep checkbox is described by it", () => {
      const view = openSheet();
      expect(keepNote(view).getAttribute("role")).toBe("status");
      expect(keepInput(view).getAttribute("aria-describedby")).toBe(keepNote(view).id);
      expect(keepNote(view).id).not.toBe("");
    });

    it("lockNote is a live region and BOTH lock checkboxes are described by the same note", () => {
      const view = openSheet();
      expect(lockNote(view).getAttribute("role")).toBe("status");
      expect(lockNote(view).id).not.toBe("");
      expect(tabInput(view).getAttribute("aria-describedby")).toBe(lockNote(view).id);
      expect(screenInput(view).getAttribute("aria-describedby")).toBe(lockNote(view).id);
    });

    it("signOutStatus is a live region", () => {
      const view = openSheet();
      expect(signOutStatus(view).getAttribute("role")).toBe("status");
    });

    it("the auto-lock checkbox is described by the greyed-out reason note, even while it is hidden", () => {
      const view = openSheet();
      expect(idleInput(view).getAttribute("aria-describedby")).toBe(idleNote(view).id);
      expect(idleNote(view).id).not.toBe("");
      expect(idleNote(view).hidden).toBe(true); // no grant yet — the reason does not apply
    });

    it("two sheets mounted at once never collide on an id (each gets its own sequence number)", () => {
      const a = openSheet();
      const b = openSheet();
      expect(keepNote(a).id).not.toBe(keepNote(b).id);
      expect(lockNote(a).id).not.toBe(lockNote(b).id);
      expect(idleNote(a).id).not.toBe(idleNote(b).id);
    });
  });

  // ===========================================================================================
  describe("Keep this device unlocked — turning it off", () => {
    it("forgets the grant locally FIRST, then asks the server to revoke it", async () => {
      seedGrant({ [GRANT_PAUSED_KEY]: "1" });
      const pending = deferred<Response>();
      fetchMock.mockReturnValueOnce(pending.promise);
      const view = openSheet();

      keepInput(view).click();

      // Nothing has been answered yet, and the device has already let go.
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
      expect(stored(GRANT_PAUSED_KEY)).toBeNull();
      expect(keepInput(view).checked).toBe(false);
      expect(keepNote(view).hidden).toBe(true);
      expect(idleInput(view).disabled).toBe(false);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const { url, init, headers } = lastFetch();
      expect(url).toBe(`/api/admin/server/device-grants/${GRANT.grantId}`);
      expect(init.method).toBe("DELETE");
      expectGuardAndToken(headers);

      pending.resolve(noContent());
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(hooks.lockNow).not.toHaveBeenCalled();
      expect(keepInput(view).checked).toBe(false);
    });

    it("stays off when the server refuses (500)", async () => {
      seedGrant();
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "x" }, 500));
      const view = openSheet();
      keepInput(view).click();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
      expect(keepInput(view).checked).toBe(false);
      expect(hooks.lockNow).not.toHaveBeenCalled();
    });

    it("stays off when the network fails", async () => {
      seedGrant();
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      const view = openSheet();
      keepInput(view).click();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
      expect(hooks.lockNow).not.toHaveBeenCalled();
    });

    it("locks the chat if the revoke comes back 401, and the grant is still gone", async () => {
      seedGrant();
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "locked" }, 401));
      const view = openSheet();
      keepInput(view).click();
      await vi.waitFor(() => expect(hooks.lockNow).toHaveBeenCalledWith("unauthorized"));
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
    });

    it("treats a 404 as done — already revoked is the same outcome", async () => {
      seedGrant();
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "not_found" }, 404));
      const view = openSheet();
      keepInput(view).click();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(hooks.lockNow).not.toHaveBeenCalled();
      expect(keepInput(view).checked).toBe(false);
    });

    it("clears the grant locally without a request when the chat has no session", () => {
      seedGrant();
      const view = openSheet();
      session = null;
      keepInput(view).click();
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================================
  describe("Sign out other devices", () => {
    it("revokes every grant, clears this device's own, and says so", async () => {
      seedGrant();
      const pending = deferred<Response>();
      fetchMock.mockReturnValueOnce(pending.promise);
      const view = openSheet();

      signOutButton(view).click();

      expect(signOutButton(view).disabled).toBe(true);
      expect(signOutStatus(view).hidden).toBe(false);
      expect(signOutStatus(view).textContent).toBe("Signing out…");
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const { url, init, headers } = lastFetch();
      expect(url).toBe("/api/admin/server/device-grants");
      expect(init.method).toBe("DELETE");
      expectGuardAndToken(headers);
      // Still in flight: this device's grant is not forgotten until the server has answered.
      expect(stored(DEVICE_GRANT_KEY)).not.toBeNull();

      pending.resolve(noContent());
      await vi.waitFor(() => expect(signOutStatus(view).textContent).toBe("Done — the other devices are signed out."));
      expect(stored(DEVICE_GRANT_KEY)).toBeNull();
      expect(keepInput(view).checked).toBe(false);
      expect(idleInput(view).disabled).toBe(false);
      expect(signOutButton(view).disabled).toBe(false);
    });

    it("works when this device had no grant of its own", async () => {
      fetchMock.mockResolvedValueOnce(noContent());
      const view = openSheet();
      signOutButton(view).click();
      await vi.waitFor(() => expect(signOutStatus(view).textContent).toBe("Done — the other devices are signed out."));
      expect(keepInput(view).checked).toBe(false);
    });

    it("says it could not, keeps this device's grant, and re-enables the button when the server fails", async () => {
      seedGrant();
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "x" }, 500));
      const view = openSheet();
      signOutButton(view).click();
      await vi.waitFor(() =>
        expect(signOutStatus(view).textContent).toBe("Couldn't sign the other devices out — try again."),
      );
      expect(stored(DEVICE_GRANT_KEY)).not.toBeNull();
      expect(keepInput(view).checked).toBe(true);
      expect(signOutButton(view).disabled).toBe(false);
    });

    it("says it could not when the network fails", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      const view = openSheet();
      signOutButton(view).click();
      await vi.waitFor(() =>
        expect(signOutStatus(view).textContent).toBe("Couldn't sign the other devices out — try again."),
      );
      expect(signOutButton(view).disabled).toBe(false);
    });

    it("locks the chat on a 401, without claiming success", async () => {
      seedGrant();
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "locked" }, 401));
      const view = openSheet();
      signOutButton(view).click();
      await vi.waitFor(() => expect(hooks.lockNow).toHaveBeenCalledWith("unauthorized"));
      expect(signOutStatus(view).textContent).not.toContain("Done");
      expect(stored(DEVICE_GRANT_KEY)).not.toBeNull();
      expect(signOutButton(view).disabled).toBe(false);
    });

    it("does nothing without a session", () => {
      const view = openSheet();
      session = null;
      signOutButton(view).click();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(signOutStatus(view).hidden).toBe(true);
    });

    it("hides the previous result when the sheet is opened again", async () => {
      fetchMock.mockResolvedValueOnce(noContent());
      const view = openSheet();
      signOutButton(view).click();
      await vi.waitFor(() => expect(signOutStatus(view).hidden).toBe(false));
      view.close();
      view.open();
      expect(signOutStatus(view).hidden).toBe(true);
    });
  });

  // ===========================================================================================
  describe("Lock when I change tab / Lock when I lock my screen — a browser with no IdleDetector", () => {
    it("shows both boxes ticked by default, the screen box disabled and greyed, and the plain line", () => {
      const view = openSheet();
      expect(tabInput(view).checked).toBe(true);
      expect(screenInput(view).checked).toBe(true);
      expect(tabInput(view).disabled).toBe(false);
      expect(screenInput(view).disabled).toBe(true);
      expect(screenRow(view).classList.contains("wx-srv-sheet-row-disabled")).toBe(true);
      expect(lockNote(view).hidden).toBe(false);
      expect(lockNote(view).textContent).toBe(MIRROR_NOTE);
      expect(stored(LOCK_ON_TAB_KEY)).toBeNull();
      expect(stored(LOCK_ON_SCREEN_KEY)).toBeNull();
    });

    it("labels both boxes exactly", () => {
      const view = openSheet();
      expect(view.element.querySelector(`label[for="${tabInput(view).id}"]`)?.textContent?.trim()).toBe(
        "Lock when I change tab",
      );
      expect(view.element.querySelector(`label[for="${screenInput(view).id}"]`)?.textContent?.trim()).toBe(
        "Lock when I lock my screen",
      );
    });

    it("unticking the tab box writes BOTH keys as '0' and shows both unticked", () => {
      const view = openSheet();
      tabInput(view).click();
      expect(stored(LOCK_ON_TAB_KEY)).toBe("0");
      expect(stored(LOCK_ON_SCREEN_KEY)).toBe("0");
      expect(tabInput(view).checked).toBe(false);
      expect(screenInput(view).checked).toBe(false);
      expect(lockNote(view).textContent).toBe(MIRROR_NOTE);
    });

    it("re-ticking the tab box removes both keys", () => {
      const view = openSheet();
      tabInput(view).click();
      tabInput(view).click();
      expect(stored(LOCK_ON_TAB_KEY)).toBeNull();
      expect(stored(LOCK_ON_SCREEN_KEY)).toBeNull();
      expect(tabInput(view).checked).toBe(true);
      expect(screenInput(view).checked).toBe(true);
    });

    it("clicking the disabled screen box does nothing", () => {
      const view = openSheet();
      screenInput(view).click();
      expect(stored(LOCK_ON_SCREEN_KEY)).toBeNull();
      expect(screenInput(view).checked).toBe(true);
    });

    it("stored values that disagree read as BOTH ticked — losing the detector never quietly drops a lock", () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      const view = openSheet();
      expect(tabInput(view).checked).toBe(true);
      expect(screenInput(view).checked).toBe(true);
      window.localStorage.clear();
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      view.close();
      view.open();
      expect(tabInput(view).checked).toBe(true);
      expect(screenInput(view).checked).toBe(true);
    });

    it("from that disagreeing state, unticking the tab box brings both to the tab box's value", () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      const view = openSheet();
      tabInput(view).click();
      expect(stored(LOCK_ON_TAB_KEY)).toBe("0");
      expect(stored(LOCK_ON_SCREEN_KEY)).toBe("0");
      expect(tabInput(view).checked).toBe(false);
      expect(screenInput(view).checked).toBe(false);
    });

    it("follows a change made elsewhere while the sheet is open", () => {
      const view = openSheet();
      setLockSettings(window, { lockOnTab: false, lockOnScreen: false });
      expect(tabInput(view).checked).toBe(false);
      expect(screenInput(view).checked).toBe(false);
    });

    it("announces a change so the panel can react", () => {
      const listener = vi.fn();
      window.addEventListener(LOCK_PREFS_CHANGED_EVENT, listener);
      const view = openSheet();
      tabInput(view).click();
      expect(listener).toHaveBeenCalledTimes(1);
      window.removeEventListener(LOCK_PREFS_CHANGED_EVENT, listener);
    });

    it("never asks for a permission, since there is nothing to ask for", () => {
      const view = openSheet();
      tabInput(view).click();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================================
  describe("Lock preferences — permission still to be asked ('prompt')", () => {
    it("shows both boxes ticked and enabled with no note", async () => {
      const detector = installIdleDetector("prompt");
      const view = openSheet();
      await statusApplied(detector);
      expect(tabInput(view).checked).toBe(true);
      expect(screenInput(view).checked).toBe(true);
      expect(screenInput(view).disabled).toBe(false);
      expect(lockNote(view).hidden).toBe(true);
      expect(detector.requestPermission).not.toHaveBeenCalled();
    });

    it("making the two differ asks for the permission synchronously from the tap, and stores nothing until it answers", async () => {
      const answer = deferred<"granted" | "denied">();
      const detector = installIdleDetector("prompt", () => answer.promise);
      const view = openSheet();
      await statusApplied(detector);

      screenInput(view).click();

      // Straight from the tap: no await has happened, yet the browser prompt has been requested.
      expect(detector.requestPermission).toHaveBeenCalledTimes(1);
      expect(stored(LOCK_ON_SCREEN_KEY)).toBeNull();
      expect(stored(LOCK_ON_TAB_KEY)).toBeNull();

      answer.resolve("granted");
      await vi.waitFor(() => expect(stored(LOCK_ON_SCREEN_KEY)).toBe("0"));
      expect(stored(LOCK_ON_TAB_KEY)).toBeNull();
      expect(tabInput(view).checked).toBe(true);
      expect(screenInput(view).checked).toBe(false);
      expect(screenInput(view).disabled).toBe(false);
      expect(lockNote(view).hidden).toBe(true);
    });

    it("announces the stored change once the permission is granted", async () => {
      const detector = installIdleDetector("prompt");
      const listener = vi.fn();
      window.addEventListener(LOCK_PREFS_CHANGED_EVENT, listener);
      const view = openSheet();
      await statusApplied(detector);
      screenInput(view).click();
      await vi.waitFor(() => expect(stored(LOCK_ON_SCREEN_KEY)).toBe("0"));
      expect(listener).toHaveBeenCalled();
      window.removeEventListener(LOCK_PREFS_CHANGED_EVENT, listener);
    });

    it("unticking the TAB box (tab off + screen on) also asks, and on grant stores only the tab key", async () => {
      const detector = installIdleDetector("prompt");
      const view = openSheet();
      await statusApplied(detector);

      tabInput(view).click();
      expect(detector.requestPermission).toHaveBeenCalledTimes(1);

      await vi.waitFor(() => expect(stored(LOCK_ON_TAB_KEY)).toBe("0"));
      expect(stored(LOCK_ON_SCREEN_KEY)).toBeNull();
      expect(tabInput(view).checked).toBe(false);
      expect(screenInput(view).checked).toBe(true);
    });

    it("on DENIAL after tapping the screen box, both fall back to mirrored and stay ticked", async () => {
      const detector = installIdleDetector("prompt", () => Promise.resolve("denied"));
      const view = openSheet();
      await statusApplied(detector);

      screenInput(view).click();

      await vi.waitFor(() => expect(screenInput(view).disabled).toBe(true));
      expect(stored(LOCK_ON_TAB_KEY)).toBeNull();
      expect(stored(LOCK_ON_SCREEN_KEY)).toBeNull();
      expect(tabInput(view).checked).toBe(true);
      expect(screenInput(view).checked).toBe(true);
      expect(screenRow(view).classList.contains("wx-srv-sheet-row-disabled")).toBe(true);
      expect(lockNote(view).hidden).toBe(false);
      expect(lockNote(view).textContent).toBe(MIRROR_NOTE);
    });

    it("on DENIAL after unticking the tab box, both follow the tab box down", async () => {
      const detector = installIdleDetector("prompt", () => Promise.resolve("denied"));
      const view = openSheet();
      await statusApplied(detector);

      tabInput(view).click();

      await vi.waitFor(() => expect(stored(LOCK_ON_TAB_KEY)).toBe("0"));
      expect(stored(LOCK_ON_SCREEN_KEY)).toBe("0");
      expect(tabInput(view).checked).toBe(false);
      expect(screenInput(view).checked).toBe(false);
      expect(screenInput(view).disabled).toBe(true);
      expect(lockNote(view).textContent).toBe(MIRROR_NOTE);
    });

    it("a request the browser throws on counts as denial", async () => {
      const detector = installIdleDetector("prompt", () => Promise.reject(new Error("NotAllowedError")));
      const view = openSheet();
      await statusApplied(detector);
      screenInput(view).click();
      await vi.waitFor(() => expect(screenInput(view).disabled).toBe(true));
      expect(stored(LOCK_ON_SCREEN_KEY)).toBeNull();
    });

    it("does not treat a browser with IdleDetector but no permission API as unsupported", async () => {
      installIdleDetector("prompt");
      Reflect.deleteProperty(navigator, "permissions");
      const view = openSheet();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(screenInput(view).disabled).toBe(false);
      expect(lockNote(view).hidden).toBe(true);
    });
  });

  // ===========================================================================================
  describe("Lock preferences — permission granted", () => {
    it("lets each box move on its own without asking again", async () => {
      const detector = installIdleDetector("granted");
      const view = openSheet();
      await statusApplied(detector);

      screenInput(view).click();
      expect(stored(LOCK_ON_SCREEN_KEY)).toBe("0");
      expect(stored(LOCK_ON_TAB_KEY)).toBeNull();
      expect(tabInput(view).checked).toBe(true);
      expect(screenInput(view).checked).toBe(false);

      tabInput(view).click();
      expect(stored(LOCK_ON_TAB_KEY)).toBe("0");
      expect(stored(LOCK_ON_SCREEN_KEY)).toBe("0");

      screenInput(view).click();
      expect(stored(LOCK_ON_SCREEN_KEY)).toBeNull();
      expect(stored(LOCK_ON_TAB_KEY)).toBe("0");
      expect(detector.requestPermission).not.toHaveBeenCalled();
    });

    it("shows the 'lock your screen once' note only for tab OFF + screen ON on a device not yet proven", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      const detector = installIdleDetector("granted");
      const view = openSheet();
      await vi.waitFor(() => expect(lockNote(view).hidden).toBe(false));
      expect(detector.query).toHaveBeenCalled();
      expect(lockNote(view).textContent).toBe(PROOF_NOTE);
      expect(tabInput(view).checked).toBe(false);
      expect(screenInput(view).checked).toBe(true);
    });

    it("the note disappears the moment the device is proven", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      installIdleDetector("granted");
      const view = openSheet();
      await vi.waitFor(() => expect(lockNote(view).hidden).toBe(false));

      setScreenLockProven(window, true);

      expect(lockNote(view).hidden).toBe(true);
      expect(lockNote(view).textContent).toBe("");
    });

    it("does not show the note on a device that is already proven", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(SCREENLOCK_PROVEN_KEY, "1");
      const detector = installIdleDetector("granted");
      const view = openSheet();
      await statusApplied(detector);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(lockNote(view).hidden).toBe(true);
    });

    it("does not show the note for tab ON + screen OFF (that combination needs no proof)", async () => {
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      const detector = installIdleDetector("granted");
      const view = openSheet();
      await statusApplied(detector);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(lockNote(view).hidden).toBe(true);
      expect(tabInput(view).checked).toBe(true);
      expect(screenInput(view).checked).toBe(false);
    });

    it("does not show the note when both boxes are off, or both on", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      const detector = installIdleDetector("granted");
      const view = openSheet();
      await statusApplied(detector);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(lockNote(view).hidden).toBe(true);
      tabInput(view).click();
      screenInput(view).click();
      expect(lockNote(view).hidden).toBe(true);
    });

    it("shows the note as soon as unticking the tab box creates the unproven combination", async () => {
      const detector = installIdleDetector("granted");
      const view = openSheet();
      await statusApplied(detector);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(lockNote(view).hidden).toBe(true);
      tabInput(view).click();
      expect(lockNote(view).hidden).toBe(false);
      expect(lockNote(view).textContent).toBe(PROOF_NOTE);
    });

    it("does not show the note when the permission is only 'prompt' — the boxes are mirrored then", async () => {
      window.localStorage.setItem(LOCK_ON_TAB_KEY, "0");
      const detector = installIdleDetector("prompt");
      const view = openSheet();
      await statusApplied(detector);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(lockNote(view).hidden).toBe(true);
      // Mirrored: the disagreeing stored values read as both ticked.
      expect(tabInput(view).checked).toBe(true);
      expect(screenInput(view).checked).toBe(true);
    });
  });

  // ===========================================================================================
  describe("Lock preferences — permission denied", () => {
    it("disables the screen box, greys its row and shows the plain line", async () => {
      installIdleDetector("denied");
      const view = openSheet();
      await vi.waitFor(() => expect(screenInput(view).disabled).toBe(true));
      expect(screenRow(view).classList.contains("wx-srv-sheet-row-disabled")).toBe(true);
      expect(lockNote(view).hidden).toBe(false);
      expect(lockNote(view).textContent).toBe(MIRROR_NOTE);
    });

    it("unticking the tab box writes both keys", async () => {
      installIdleDetector("denied");
      const view = openSheet();
      await vi.waitFor(() => expect(screenInput(view).disabled).toBe(true));
      tabInput(view).click();
      expect(stored(LOCK_ON_TAB_KEY)).toBe("0");
      expect(stored(LOCK_ON_SCREEN_KEY)).toBe("0");
      expect(screenInput(view).checked).toBe(false);
    });

    it("never asks the browser for the permission again", async () => {
      const detector = installIdleDetector("denied");
      const view = openSheet();
      await vi.waitFor(() => expect(screenInput(view).disabled).toBe(true));
      tabInput(view).click();
      tabInput(view).click();
      expect(detector.requestPermission).not.toHaveBeenCalled();
    });

    it("shows a stored disagreement as both ticked (fail closed)", async () => {
      window.localStorage.setItem(LOCK_ON_SCREEN_KEY, "0");
      installIdleDetector("denied");
      const view = openSheet();
      await vi.waitFor(() => expect(screenInput(view).disabled).toBe(true));
      expect(tabInput(view).checked).toBe(true);
      expect(screenInput(view).checked).toBe(true);
    });
  });
});
