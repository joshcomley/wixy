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
