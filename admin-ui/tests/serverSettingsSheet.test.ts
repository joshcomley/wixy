import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountServerSettingsSheet } from "../src/server/settingsSheet";
import { ServerErasureOutcomeUnknownError, ServerWipeNotCommittedError } from "../src/server/api/http";
import type { ServerIdentity } from "../src/server/identity";
import type { LockHooks, ServerSession } from "../src/server/types";

const { getUsage } = vi.hoisted(() => ({ getUsage: vi.fn() }));
vi.mock("../src/server/api/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/messages")>()),
  getUsage,
}));

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };

function identity(): ServerIdentity {
  return {
    getName: () => "Josh",
    setName: vi.fn(),
    getDeviceId: () => "device-1",
    isMine: () => true,
  };
}

function hooks(): LockHooks {
  return { suspend: vi.fn(() => () => {}), lockNow: vi.fn() };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("mountServerSettingsSheet wipe confirmation", () => {
  beforeEach(() => {
    getUsage.mockReset().mockResolvedValue({ mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false });
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("mounts the notifications toggle only on an Android push-capable browser", () => {
    Object.defineProperty(window, "PushManager", { configurable: true, value: class PushManager {} });
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: { permission: "default", requestPermission: vi.fn(async () => "granted") },
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: vi.fn(), ready: Promise.resolve({}) },
    });
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: vi.fn(async () => Response.json({ publicKey: "AQ", subscribed: false })),
    });
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 Android 14",
    });

    const androidView = mountServerSettingsSheet({
      identity: identity(),
      hooks: hooks(),
      win: window,
      getSession: () => SESSION,
      onWipe: vi.fn(),
      onNameChanged: vi.fn(),
      onClose: vi.fn(),
    });
    androidView.open();
    expect(androidView.pushSlot.querySelector(".wx-srv-push-toggle")).not.toBeNull();
    androidView.teardown();

    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 Desktop",
    });
    const desktopView = mountServerSettingsSheet({
      identity: identity(),
      hooks: hooks(),
      win: window,
      getSession: () => SESSION,
      onWipe: vi.fn(),
      onNameChanged: vi.fn(),
      onClose: vi.fn(),
    });
    desktopView.open();
    expect(desktopView.pushSlot.querySelector(".wx-srv-push-toggle")).toBeNull();
    desktopView.teardown();
  });

  it("shows used and quota bytes from /usage", async () => {
    getUsage.mockResolvedValueOnce({
      mediaAvailable: true, usedBytes: 1536, quotaBytes: 1_048_576, freeBytes: 1_047_040, erasurePending: false,
    });
    const view = mountServerSettingsSheet({
      identity: identity(),
      hooks: hooks(),
      win: window,
      getSession: () => SESSION,
      onWipe: vi.fn(),
      onNameChanged: vi.fn(),
      onClose: vi.fn(),
    });
    document.body.appendChild(view.element);
    view.open();
    await flush();

    expect(view.element.querySelector(".wx-srv-sheet-usage")?.textContent)
      .toBe("Storage: 1.5 KB of 1 MB used");
    view.teardown();
  });

  it("shows the unavailable and failure storage states", async () => {
    const view = mountServerSettingsSheet({
      identity: identity(),
      hooks: hooks(),
      win: window,
      getSession: () => SESSION,
      onWipe: vi.fn(),
      onNameChanged: vi.fn(),
      onClose: vi.fn(),
    });
    document.body.appendChild(view.element);

    getUsage.mockResolvedValueOnce({
      mediaAvailable: false, usedBytes: 0, quotaBytes: 0, freeBytes: 0, erasurePending: false,
    });
    view.open();
    await flush();
    expect(view.element.querySelector(".wx-srv-sheet-usage")?.textContent)
      .toBe("Storage: media isn't available on this server.");

    getUsage.mockRejectedValueOnce(new Error("storage request failed"));
    view.open();
    await flush();
    expect(view.element.querySelector(".wx-srv-sheet-usage")?.textContent).toBe("Storage: couldn't load.");
    view.teardown();
  });

  it("requires the two-step destructive confirmation before wiping", async () => {
    const onWipe = vi.fn().mockResolvedValue(false);
    const view = mountServerSettingsSheet({
      identity: identity(),
      hooks: hooks(),
      win: window,
      getSession: () => SESSION,
      onWipe,
      onNameChanged: vi.fn(),
      onClose: vi.fn(),
    });
    document.body.appendChild(view.element);
    view.open();
    await flush();

    view.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe")?.click();
    expect(view.element.textContent).toContain(
      "Delete every message, photo, video and voice note for everyone? This can't be undone.",
    );
    expect(onWipe).not.toHaveBeenCalled();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe-confirm-button")?.click();
    await flush();

    expect(onWipe).toHaveBeenCalledOnce();
    expect(view.element.hidden).toBe(true);
    view.teardown();
  });

  it("keeps the confirmation open and explains a failed wipe", async () => {
    const onWipe = vi.fn().mockRejectedValue(new Error("network"));
    const view = mountServerSettingsSheet({
      identity: identity(),
      hooks: hooks(),
      win: window,
      getSession: () => SESSION,
      onWipe,
      onNameChanged: vi.fn(),
      onClose: vi.fn(),
    });
    document.body.appendChild(view.element);
    view.open();
    await flush();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe")?.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe-confirm-button")?.click();
    await flush();

    expect(view.element.hidden).toBe(false);
    expect(view.element.textContent).toContain("Couldn't delete everything — try again");
    view.teardown();
  });

  it("shows an unknown wipe as checking and blocks a repeat submission", async () => {
    const onWipe = vi.fn().mockRejectedValue(new ServerErasureOutcomeUnknownError());
    const view = mountServerSettingsSheet({
      identity: identity(),
      hooks: hooks(),
      win: window,
      getSession: () => SESSION,
      onWipe,
      onNameChanged: vi.fn(),
      onClose: vi.fn(),
    });
    document.body.appendChild(view.element);
    view.open();
    await flush();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe")?.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe-confirm-button")?.click();
    await flush();

    expect(view.element.textContent).toContain("Couldn't confirm — checking…");
    expect(view.element.querySelector<HTMLDivElement>(".wx-srv-sheet-wipe-confirm")?.hidden).toBe(true);
    const wipeButton = view.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe");
    expect(wipeButton?.disabled).toBe(true);
    wipeButton?.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe-confirm-button")?.click();
    expect(onWipe).toHaveBeenCalledOnce();

    view.close();
    getUsage.mockResolvedValueOnce({
      mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: true,
    });
    view.open();
    await flush();
    expect(view.element.textContent).toContain("Couldn't confirm — checking…");
    expect(view.element.textContent).not.toContain("Deleted. Erasing leftover traces…");
    view.teardown();
  });

  describe("an unknown wipe outcome from a provider with no reconciler (F16)", () => {
    // `onWipe` rejecting with ServerErasureOutcomeUnknownError leaves the sheet with
    // nothing but /usage to look at. It used to stay 'checking' with the wipe control
    // disabled forever (the poll simply stopped at 60 s, or never restarted after a
    // close/reopen). It now gives up honestly and hands the decision back to the owner.
    function mountUnknownWipeSheet() {
      const view = mountServerSettingsSheet({
        identity: identity(),
        hooks: hooks(),
        win: window,
        getSession: () => SESSION,
        onWipe: vi.fn().mockRejectedValue(new ServerErasureOutcomeUnknownError()),
        onNameChanged: vi.fn(),
        onClose: vi.fn(),
      });
      document.body.appendChild(view.element);
      return view;
    }
    const wipeButton = (view: { element: HTMLElement }) =>
      view.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe");
    const status = (view: { element: HTMLElement }) =>
      view.element.querySelector(".wx-srv-sheet-wipe-status")?.textContent;

    async function submitWipe(view: { element: HTMLElement }): Promise<void> {
      wipeButton(view)?.click();
      view.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe-confirm-button")?.click();
      await vi.advanceTimersByTimeAsync(0);
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("says the status is unclear and re-enables the wipe control once nothing is pending", async () => {
      const view = mountUnknownWipeSheet();
      view.open();
      await vi.advanceTimersByTimeAsync(0);
      await submitWipe(view);
      expect(status(view)).toBe("Couldn't confirm — checking…");
      expect(wipeButton(view)?.disabled).toBe(true);

      await vi.advanceTimersByTimeAsync(1_500);

      expect(status(view)).toBe("Status unclear. Check the messages to confirm.");
      expect(wipeButton(view)?.disabled).toBe(false);
      view.teardown();
    });

    it("gives up after the polling window instead of staying 'checking' forever", async () => {
      getUsage.mockReset().mockResolvedValue({
        mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: true,
      });
      const view = mountUnknownWipeSheet();
      view.open();
      await vi.advanceTimersByTimeAsync(0);
      await submitWipe(view);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(status(view)).toBe("Couldn't confirm — checking…");
      expect(wipeButton(view)?.disabled).toBe(true);

      await vi.advanceTimersByTimeAsync(31_000);

      expect(status(view)).toBe("Status unclear. Check the messages to confirm.");
      expect(wipeButton(view)?.disabled).toBe(false);
      view.teardown();
    });

    it("a close and reopen before the check finished does not strand the control", async () => {
      const view = mountUnknownWipeSheet();
      view.open();
      await vi.advanceTimersByTimeAsync(0);
      await submitWipe(view);
      view.close();
      await vi.advanceTimersByTimeAsync(5_000);

      view.open();
      await vi.advanceTimersByTimeAsync(1_500);

      expect(status(view)).toBe("Status unclear. Check the messages to confirm.");
      expect(wipeButton(view)?.disabled).toBe(false);
      view.teardown();
    });

    it("never re-submits while it is still checking", async () => {
      getUsage.mockReset().mockResolvedValue({
        mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: true,
      });
      const onWipe = vi.fn().mockRejectedValue(new ServerErasureOutcomeUnknownError());
      const view = mountServerSettingsSheet({
        identity: identity(),
        hooks: hooks(),
        win: window,
        getSession: () => SESSION,
        onWipe,
        onNameChanged: vi.fn(),
        onClose: vi.fn(),
      });
      document.body.appendChild(view.element);
      view.open();
      await vi.advanceTimersByTimeAsync(0);
      await submitWipe(view);
      view.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe-confirm-button")?.click();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(onWipe).toHaveBeenCalledOnce();
      view.teardown();
    });
  });

  it("keeps wipe confirmation retryable after history proves the wipe did not commit", async () => {
    const onWipe = vi.fn()
      .mockRejectedValueOnce(new ServerWipeNotCommittedError())
      .mockResolvedValueOnce(false);
    const view = mountServerSettingsSheet({
      identity: identity(),
      hooks: hooks(),
      win: window,
      getSession: () => SESSION,
      onWipe,
      onNameChanged: vi.fn(),
      onClose: vi.fn(),
    });
    document.body.appendChild(view.element);
    view.open();
    await flush();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe")?.click();
    const confirm = view.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe-confirm-button")!;
    confirm.click();
    await flush();

    expect(view.element.querySelector<HTMLParagraphElement>(".wx-srv-sheet-wipe-error")?.textContent)
      .toBe("Couldn't delete everything — try again");
    expect(view.element.querySelector<HTMLDivElement>(".wx-srv-sheet-wipe-confirm")?.hidden).toBe(false);
    confirm.click();
    await flush();
    expect(onWipe).toHaveBeenCalledTimes(2);
    view.teardown();
  });

  it("shows and polls the pending-scrub status returned by HTTP 202", async () => {
    vi.useFakeTimers();
    const onWipe = vi.fn().mockResolvedValue(true);
    getUsage
      .mockResolvedValueOnce({ mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false })
      .mockResolvedValueOnce({ mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: true })
      .mockResolvedValueOnce({ mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false });
    const view = mountServerSettingsSheet({
      identity: identity(),
      hooks: hooks(),
      win: window,
      getSession: () => SESSION,
      onWipe,
      onNameChanged: vi.fn(),
      onClose: vi.fn(),
    });
    document.body.appendChild(view.element);
    view.open();
    await flush();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe")?.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-sheet-wipe-confirm-button")?.click();
    await flush();

    expect(view.element.hidden).toBe(false);
    expect(view.element.textContent).toContain("Deleted. Erasing leftover traces…");
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(view.element.textContent).not.toContain("Done");
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(view.element.textContent).toContain("Done");
    view.teardown();
  });
});

// The per-device "Extend auto-lock to 1 minute" checkbox. Device-local only:
// the stored value lives in localStorage under `wx-srv-idle-extended` and
// nothing about it ever goes to the server.
describe("mountServerSettingsSheet auto-lock checkbox", () => {
  const LABEL = "Extend auto-lock to 1 minute";

  beforeEach(() => {
    vi.useRealTimers();
    getUsage.mockReset().mockResolvedValue({ mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false });
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.body.innerHTML = "";
  });

  function mountSheet(lockHooks: LockHooks = hooks()): ReturnType<typeof mountServerSettingsSheet> {
    const view = mountServerSettingsSheet({
      identity: identity(),
      hooks: lockHooks,
      win: window,
      getSession: () => SESSION,
      onWipe: vi.fn(),
      onNameChanged: vi.fn(),
      onClose: vi.fn(),
    });
    document.body.appendChild(view.element);
    return view;
  }

  function checkbox(view: ReturnType<typeof mountServerSettingsSheet>): HTMLInputElement {
    const input = view.element.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (input === null) throw new Error("no checkbox rendered in the settings sheet");
    return input;
  }

  it("renders exactly one real checkbox with a real <label for> reading exactly 'Extend auto-lock to 1 minute'", () => {
    const view = mountSheet();
    expect(view.element.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    const input = checkbox(view);
    expect(input.id).not.toBe("");
    const label = view.element.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`);
    expect(label).not.toBeNull();
    expect(label?.textContent?.trim()).toBe(LABEL);
    expect(input.labels).toHaveLength(1);
    expect(input.labels?.[0]).toBe(label);
    view.teardown();
  });

  it("gives every mounted sheet its own checkbox id, so the label always points at its own box", () => {
    const first = mountSheet();
    const second = mountSheet();
    expect(checkbox(first).id).not.toBe(checkbox(second).id);
    first.teardown();
    second.teardown();
  });

  it("is unticked by default and keyboard reachable (enabled, in the tab order)", () => {
    const view = mountSheet();
    view.open();
    const input = checkbox(view);
    expect(input.checked).toBe(false);
    expect(input.disabled).toBe(false);
    expect(input.tabIndex).toBeGreaterThanOrEqual(0);
    input.focus();
    expect(document.activeElement).toBe(input);
    view.teardown();
  });

  it("reflects the stored value every time the sheet opens", () => {
    const view = mountSheet();
    window.localStorage.setItem("wx-srv-idle-extended", "1");
    view.open();
    expect(checkbox(view).checked).toBe(true);
    view.close();

    window.localStorage.removeItem("wx-srv-idle-extended");
    view.open();
    expect(checkbox(view).checked).toBe(false);
    view.close();

    window.localStorage.setItem("wx-srv-idle-extended", "yes"); // any value but "1" is OFF
    view.open();
    expect(checkbox(view).checked).toBe(false);
    view.teardown();
  });

  it("ticking persists '1' and announces the change; unticking removes the key", () => {
    const changed = vi.fn();
    window.addEventListener("wx-srv-idle-preference-changed", changed);
    const view = mountSheet();
    view.open();
    const input = checkbox(view);

    input.click();
    expect(input.checked).toBe(true);
    expect(window.localStorage.getItem("wx-srv-idle-extended")).toBe("1");
    expect(changed).toHaveBeenCalledTimes(1);

    input.click();
    expect(input.checked).toBe(false);
    expect(window.localStorage.getItem("wx-srv-idle-extended")).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);

    window.removeEventListener("wx-srv-idle-preference-changed", changed);
    view.teardown();
  });

  it("clicking the label text toggles the box too", () => {
    const view = mountSheet();
    view.open();
    const label = view.element.querySelector<HTMLLabelElement>(`label[for="${checkbox(view).id}"]`);
    label?.click();
    expect(checkbox(view).checked).toBe(true);
    expect(window.localStorage.getItem("wx-srv-idle-extended")).toBe("1");
    view.teardown();
  });

  it("stays on this device: toggling makes no network request and never locks or suspends", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const lockHooks = hooks();
    const view = mountSheet(lockHooks);
    view.open();
    getUsage.mockClear();
    checkbox(view).click();
    checkbox(view).click();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getUsage).not.toHaveBeenCalled();
    expect(lockHooks.lockNow).not.toHaveBeenCalled();
    expect(lockHooks.suspend).not.toHaveBeenCalled();
    view.teardown();
  });

  it("a refused write leaves the box honest: it snaps back to what is actually stored", () => {
    const view = mountSheet();
    view.open();
    const input = checkbox(view);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    input.click();
    expect(window.localStorage.getItem("wx-srv-idle-extended")).toBeNull();
    expect(input.checked).toBe(false);
    view.teardown();
  });

  it("sits with the other settings rows, before the destructive wipe button and the Lock button", () => {
    const view = mountSheet();
    const children = Array.from(view.element.querySelector(".wx-srv-sheet")?.children ?? []);
    const row = children.find((child) => child.querySelector('input[type="checkbox"]') !== null);
    const wipe = children.find((child) => child.classList.contains("wx-srv-sheet-wipe"));
    const lock = children.find((child) => child.classList.contains("wx-srv-sheet-lock"));
    if (row === undefined || wipe === undefined || lock === undefined) throw new Error("expected rows missing");
    expect(children.indexOf(row)).toBeLessThan(children.indexOf(wipe));
    expect(children.indexOf(row)).toBeLessThan(children.indexOf(lock));
    view.teardown();
  });
});
