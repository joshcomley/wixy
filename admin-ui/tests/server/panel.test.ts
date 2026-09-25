// Integration coverage for the orchestrator: the full unlock flow, every R6
// lock trigger, R7's suspension timer math on a fake clock, and — the DM
// brief's explicit bar — a DOM query proving a lock actually DETACHES the
// chat subtree (nothing readable survives), not just hides it with CSS.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminApi, ServerVersion, SystemStatus } from "../../src/api";
import {
  FADE_MS,
  IDLE_LOCK_EXTENDED_MS,
  IDLE_LOCK_MS,
  MULTI_TAP_INTERVAL_MS,
  PICKER_SUSPEND_MAX_MS,
} from "../../src/server/constants";
import { createServerChatView as createRealServerChatView } from "../../src/server/chatView";
import { IDLE_EXTENDED_KEY, setIdleLockExtended } from "../../src/server/idlePreference";
import { mountServerPanel, type ServerPanelDeps } from "../../src/server/panel";
import type { CreateServerChatView, LockHooks, ServerChatView, ServerSession } from "../../src/server/types";

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

describe("mountServerPanel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let api: Pick<AdminApi, "getSystemStatus" | "getServerVersion">;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    api = {
      getSystemStatus: vi.fn().mockResolvedValue(fakeSystemStatus()),
      getServerVersion: vi.fn().mockResolvedValue(FAKE_VERSION),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
    // The "Extend auto-lock to 1 minute" preference is per-device localStorage —
    // never let one test's tick leak into the next.
    window.localStorage.clear();
  });

  async function flush(times = 10): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve();
  }

  function mount(deps: Partial<ServerPanelDeps> = {}): ReturnType<typeof mountServerPanel> {
    const panel = mountServerPanel({ api, ...deps });
    document.body.appendChild(panel.element);
    return panel;
  }

  function digitButton(root: HTMLElement, label: string): HTMLButtonElement {
    const button = Array.from(root.querySelectorAll<HTMLButtonElement>(".wx-srv-pinpad-key")).find(
      (b) => b.textContent === label,
    );
    if (button === undefined) throw new Error(`no pin pad key labelled ${label}`);
    return button;
  }

  /** A real tap fires `pointerdown` before `click` — jsdom's own `.click()`
   * only synthesizes the `click` half, which would silently hide any bug in
   * the (separately, document-level, capture-phase) `pointerdown` listener
   * R3's `multiTapDetector` uses (see gestures.ts). */
  function tap(button: HTMLButtonElement): void {
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    button.click();
  }

  async function enterAndSubmitPin(root: HTMLElement, pin: string): Promise<void> {
    for (const digit of pin) tap(digitButton(root, digit));
    tap(digitButton(root, "✓"));
    await flush();
  }

  /** R2 v1.3 (operator decision #974): a SINGLE tap anywhere in the panel
   * reveals the affordance — multi-tap has no meaning on the decoy. */
  function openAffordance(root: HTMLElement): void {
    root.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  }

  /** Reveals, clears the "ignore a tap <400ms after reveal" debounce, then
   * taps the affordance for real. */
  async function openPinPad(root: HTMLElement): Promise<void> {
    openAffordance(root);
    await vi.advanceTimersByTimeAsync(MULTI_TAP_INTERVAL_MS + 1);
    (root.querySelector(".wx-srv-affordance") as HTMLButtonElement).click();
  }

  function setHidden(hidden: boolean): void {
    Object.defineProperty(document, "visibilityState", {
      value: hidden ? "hidden" : "visible",
      configurable: true,
    });
  }

  function expiresIn(seconds: number): number {
    return Date.now() / 1000 + seconds;
  }

  // -- Mount / disguise / reveal --------------------------------------------

  it("mounts with the decoy visible and everything else hidden", () => {
    const panel = mount();
    expect(panel.element.querySelector(".wx-srv-decoy")).not.toBeNull();
    expect((panel.element.querySelector(".wx-srv-affordance") as HTMLElement).hidden).toBe(true);
    expect((panel.element.querySelector(".wx-srv-pinpad-host") as HTMLElement).hidden).toBe(true);
    expect((panel.element.querySelector(".wx-srv-chat-host") as HTMLElement).hidden).toBe(true);
    panel.teardown();
  });

  it("R2 v1.3: a SINGLE tap reveals the affordance (no multi-tap needed)", () => {
    const panel = mount();
    expect((panel.element.querySelector(".wx-srv-affordance") as HTMLElement).hidden).toBe(true);
    openAffordance(panel.element);
    expect((panel.element.querySelector(".wx-srv-affordance") as HTMLElement).hidden).toBe(false);
    panel.teardown();
  });

  it("R2 v1.3: tapping the affordance AFTER the debounce opens the pin pad titled 'Unlock server'", async () => {
    const panel = mount();
    await openPinPad(panel.element);
    expect((panel.element.querySelector(".wx-srv-pinpad-host") as HTMLElement).hidden).toBe(false);
    expect(panel.element.querySelector(".wx-srv-pinpad-title")?.textContent).toBe("Unlock server");
    panel.teardown();
  });

  it("R2 v1.3: a tap on the affordance WITHIN 400ms of the reveal is ignored (accidental rapid double-tap)", () => {
    const panel = mount();
    openAffordance(panel.element);
    // No time advanced — this click lands in the same instant as the reveal.
    (panel.element.querySelector(".wx-srv-affordance") as HTMLButtonElement).click();
    expect((panel.element.querySelector(".wx-srv-pinpad-host") as HTMLElement).hidden).toBe(true);
    panel.teardown();
  });

  it("Cancel on the pin pad returns to the decoy", async () => {
    const panel = mount();
    await openPinPad(panel.element);
    (panel.element.querySelector(".wx-srv-pinpad-cancel") as HTMLButtonElement).click();
    expect((panel.element.querySelector(".wx-srv-pinpad-host") as HTMLElement).hidden).toBe(true);
    panel.teardown();
  });

  // -- Unlock outcomes --------------------------------------------------------

  it("a correct PIN unlocks into chat and the chat subtree appears in the DOM", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount();
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");
    expect((panel.element.querySelector(".wx-srv-chat-host") as HTMLElement).hidden).toBe(false);
    expect(panel.element.querySelector(".wx-srv-thread")).not.toBeNull();
    panel.teardown();
  });

  it("physical digit keys, Backspace and Enter drive the pad too", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount();
    await openPinPad(panel.element);
    const pad = panel.element.querySelector(".wx-srv-pinpad") as HTMLElement;
    for (const key of ["1", "2", "9", "4"]) {
      pad.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    }
    pad.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    pad.dispatchEvent(new KeyboardEvent("keydown", { key: "4", bubbles: true }));
    expect(panel.element.querySelectorAll(".wx-srv-pinpad-dot")).toHaveLength(4); // "1","2","4","4"
    pad.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(panel.element.querySelector(".wx-srv-thread")).not.toBeNull();
    panel.teardown();
  });

  it("wrong PIN shows the attempts remaining and stays on the pad", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "wrong_pin", attemptsLeft: 2 }, 401));
    const panel = mount();
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "0000");
    expect(panel.element.querySelector(".wx-srv-pinpad-message")?.textContent).toBe("Wrong PIN — 2 attempts left");
    expect((panel.element.querySelector(".wx-srv-pinpad-host") as HTMLElement).hidden).toBe(false);
    panel.teardown();
  });

  it("a lockout shows the real wait, counting down, until the retry period expires (F15)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "locked_out", retryAfterS: 5 }, 429));
    const panel = mount();
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "0000");
    expect(panel.element.querySelector(".wx-srv-pinpad-message")?.textContent).toBe(
      "Too many wrong tries. Try again in 5 seconds.",
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(panel.element.querySelector(".wx-srv-pinpad-message")?.textContent).toBe(
      "Too many wrong tries. Try again in 3 seconds.",
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(panel.element.querySelector(".wx-srv-pinpad-message")?.textContent).toBe("");
    panel.teardown();
  });

  it("cmd unreachable (503) shows exactly 'Server settings unavailable.'", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "pin_service_unavailable" }, 503));
    const panel = mount();
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "0000");
    expect(panel.element.querySelector(".wx-srv-pinpad-message")?.textContent).toBe(
      "Server settings unavailable.",
    );
    panel.teardown();
  });

  it.each([
    [409, { error: "pin_changed" }, "Please try again."],
    [422, { error: "invalid" }, "Couldn't unlock — try again."],
    [418, {}, "Couldn't unlock — try again."],
  ] as const)("status %i shows the matching retry copy", async (status, body, copy) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(body, status));
    const panel = mount();
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "0000");
    expect(panel.element.querySelector(".wx-srv-pinpad-message")?.textContent).toBe(copy);
    panel.teardown();
  });

  // -- Lock triggers: every one must DETACH the chat subtree, not just hide it --

  it("Escape locks instantly and detaches the chat subtree — nothing readable survives in the DOM", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount();
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");
    expect(panel.element.querySelector(".wx-srv-thread")).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(panel.element.querySelector(".wx-srv-thread")).toBeNull();
    expect((panel.element.querySelector(".wx-srv-chat-host") as HTMLElement).hidden).toBe(true);
    expect(panel.element.querySelector(".wx-srv-decoy")).not.toBeNull();
    panel.teardown();
  });

  it("R3: a multi-tap inside the chat view locks instantly", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount();
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");

    const chatHost = panel.element.querySelector(".wx-srv-chat-host") as HTMLElement;
    chatHost.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    chatHost.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(panel.element.querySelector(".wx-srv-thread")).toBeNull();
    panel.teardown();
  });

  it("R3 bug fix: PIN-pad taps leave no leftover multi-tap count — ONE genuine tap in chat right after unlock never locks", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount();
    await openPinPad(panel.element);
    // PIN entry taps 5 <button> elements (digits + the checkmark) — none of
    // them excluded by `isExcludedTapTarget` (only textarea/input/
    // contenteditable/audio/video are), so they feed the SAME
    // multiTapDetector R3 uses inside chat and can leave it holding a
    // leftover count. Regression: `panel.ts` never reset the detector on
    // unlock, so this leftover count could combine with the very next tap
    // made inside the just-unlocked chat view to spuriously complete a
    // "multi-tap" and instantly re-lock it.
    await enterAndSubmitPin(panel.element, "1234");
    expect(panel.element.querySelector(".wx-srv-thread")).not.toBeNull();

    const chatHost = panel.element.querySelector(".wx-srv-chat-host") as HTMLElement;
    chatHost.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(panel.element.querySelector(".wx-srv-thread")).not.toBeNull(); // must NOT lock on one tap
    panel.teardown();
  });

  it("R3 exclusion: a double-tap inside a textarea in the chat view does NOT lock", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount();
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");

    const chatHost = panel.element.querySelector(".wx-srv-chat-host") as HTMLElement;
    const textarea = document.createElement("textarea");
    chatHost.appendChild(textarea);
    textarea.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    textarea.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(panel.element.querySelector(".wx-srv-thread")).not.toBeNull();
    panel.teardown();
  });

  it("hooks.lockNow('unauthorized') locks instantly — a 401 from serverFetch", async () => {
    const chatFactory = trackedChatViewFactory();
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount({ createServerChatView: chatFactory.createServerChatView });
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");
    const hooks = chatFactory.hooks;
    if (hooks === null) throw new Error("hooks not captured");

    hooks.lockNow("unauthorized");

    expect(panel.element.querySelector(".wx-srv-thread")).toBeNull();
    panel.teardown();
  });

  it("the tab becoming hidden locks instantly with no suspension active", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount();
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(panel.element.querySelector(".wx-srv-thread")).toBeNull();
    setHidden(false);
    panel.teardown();
  });

  it("hidden does NOT lock while a file picker or mic-permission prompt is open (R6's one exception)", async () => {
    const chatFactory = trackedChatViewFactory();
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount({ createServerChatView: chatFactory.createServerChatView });
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");
    const hooks = chatFactory.hooks;
    if (hooks === null) throw new Error("hooks not captured");
    const release = hooks.suspend("micPermission");

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(panel.element.querySelector(".wx-srv-thread")).not.toBeNull();

    release();
    setHidden(false);
    panel.teardown();
  });

  it("a 'mediaPlaying'/'recording' suspension does NOT excuse hidden — only filePicker/micPermission do", async () => {
    const chatFactory = trackedChatViewFactory();
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount({ createServerChatView: chatFactory.createServerChatView });
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");
    const hooks = chatFactory.hooks;
    if (hooks === null) throw new Error("hooks not captured");
    hooks.suspend("mediaPlaying");

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(panel.element.querySelector(".wx-srv-thread")).toBeNull();
    setHidden(false);
    panel.teardown();
  });

  it("reaching the token's expiresAt locks automatically", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(30) }));
    const panel = mount();
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");

    await vi.advanceTimersByTimeAsync(30_100);
    expect(panel.element.querySelector(".wx-srv-thread")).toBeNull();
    panel.teardown();
  });

  // -- Idle timing precision ----------------------------------------------------

  it("idle for IDLE_LOCK_MS fades the chat, then detaches it after FADE_MS", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount();
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");
    const chatHost = panel.element.querySelector(".wx-srv-chat-host") as HTMLElement;

    await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS - 1);
    expect(panel.element.querySelector(".wx-srv-thread")).not.toBeNull();
    expect(chatHost.classList.contains("wx-srv-fading")).toBe(false);

    await vi.advanceTimersByTimeAsync(2); // crosses the 10s boundary
    expect(chatHost.classList.contains("wx-srv-fading")).toBe(true);
    expect(panel.element.querySelector(".wx-srv-thread")).not.toBeNull(); // still attached mid-fade

    await vi.advanceTimersByTimeAsync(FADE_MS + 1);
    expect(panel.element.querySelector(".wx-srv-thread")).toBeNull();
    panel.teardown();
  });

  it("activity extends the idle timer — no lock at 9s, still no lock 9s after that", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount();
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");

    await vi.advanceTimersByTimeAsync(9000);
    expect(panel.element.querySelector(".wx-srv-thread")).not.toBeNull();
    document.dispatchEvent(new Event("pointermove", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(9000);
    expect(panel.element.querySelector(".wx-srv-thread")).not.toBeNull();
    panel.teardown();
  });

  it("an incoming-message-style programmatic scroll does NOT count as activity (R7)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount();
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");

    const chatHost = panel.element.querySelector(".wx-srv-chat-host") as HTMLElement;
    await vi.advanceTimersByTimeAsync(9000);
    chatHost.dispatchEvent(new Event("scroll", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1100); // crosses 10s total
    expect(chatHost.classList.contains("wx-srv-fading")).toBe(true);
    panel.teardown();
  });

  // -- "Extend auto-lock to 1 minute" (per-device preference) --------------------
  //
  // Architect ruling: ONLY the unlocked chat's idle lock takes the chosen
  // duration; the decoy re-hide, the PIN pad's idle close, the 800ms fade, R7
  // suspensions and every other lock cause are unchanged. A setting change
  // applies at once but is measured from the LAST REAL ACTIVITY — toggling
  // never restarts the clock.

  async function unlockedChat(
    deps: Partial<ServerPanelDeps> = {},
  ): Promise<{ panel: ReturnType<typeof mountServerPanel>; chatHost: HTMLElement }> {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount(deps);
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");
    return { panel, chatHost: panel.element.querySelector(".wx-srv-chat-host") as HTMLElement };
  }

  function isFading(chatHost: HTMLElement): boolean {
    return chatHost.classList.contains("wx-srv-fading");
  }

  it("default (box unticked): fades at exactly 10s and detaches at 10.8s", async () => {
    const { panel, chatHost } = await unlockedChat();
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS - 1);
    expect(isFading(chatHost)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(isFading(chatHost)).toBe(true);
    await vi.advanceTimersByTimeAsync(FADE_MS - 1);
    expect(panel.element.querySelector(".wx-srv-thread")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(panel.element.querySelector(".wx-srv-thread")).toBeNull();
    panel.teardown();
  });

  it("ticked: nothing at 10s or 59.999s, fades at exactly 60s, detaches at 60.8s", async () => {
    setIdleLockExtended(window, true);
    const { panel, chatHost } = await unlockedChat();
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS + 1);
    expect(isFading(chatHost)).toBe(false);
    expect(panel.element.querySelector(".wx-srv-thread")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_EXTENDED_MS - IDLE_LOCK_MS - 2); // t = 59.999s
    expect(isFading(chatHost)).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // t = 60.000s
    expect(isFading(chatHost)).toBe(true);
    await vi.advanceTimersByTimeAsync(FADE_MS - 1);
    expect(panel.element.querySelector(".wx-srv-thread")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1); // t = 60.800s
    expect(panel.element.querySelector(".wx-srv-thread")).toBeNull();
    panel.teardown();
  });

  // The first unlock on a device shows a "What should we call you?" step INSIDE the
  // chat view. The Architect ruled it takes the same idle period as the chat; it is
  // still the panel's "chat" state, so this pins that with the REAL chat view.
  it("the first-unlock name prompt is still chat: ticked it holds for 60s, unticked it locks at 10s", async () => {
    for (const extended of [true, false]) {
      window.localStorage.clear();
      if (extended) setIdleLockExtended(window, true);
      const { panel, chatHost } = await unlockedChat({ createServerChatView: createRealServerChatView });
      const prompt = panel.element.querySelector<HTMLElement>(".wx-srv-name-prompt");
      expect(prompt?.hidden, "the name prompt should be showing (no stored name)").toBe(false);

      await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS);
      expect(isFading(chatHost)).toBe(!extended);
      if (extended) {
        await vi.advanceTimersByTimeAsync(IDLE_LOCK_EXTENDED_MS - IDLE_LOCK_MS - 1);
        expect(isFading(chatHost)).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(isFading(chatHost)).toBe(true);
      }
      panel.teardown();
      document.body.innerHTML = "";
    }
  });

  it("the stored value is the only switch: '1' extends, any other value is the normal 10s", async () => {
    window.localStorage.setItem(IDLE_EXTENDED_KEY, "true");
    const { panel, chatHost } = await unlockedChat();
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS);
    expect(isFading(chatHost)).toBe(true);
    panel.teardown();
  });

  it("ticking while unlocked applies at once and is measured from the LAST ACTIVITY, not from the tick", async () => {
    const { panel, chatHost } = await unlockedChat();
    await vi.advanceTimersByTimeAsync(5_000);
    setIdleLockExtended(window, true); // a settings change — NOT user activity
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_EXTENDED_MS - 5_000 - 1); // t = 59.999s
    expect(isFading(chatHost)).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // t = 60.000s = last activity + 60s (NOT 65s)
    expect(isFading(chatHost)).toBe(true);
    panel.teardown();
  });

  it("unticking while unlocked applies at once, measured from the last activity", async () => {
    setIdleLockExtended(window, true);
    const { panel, chatHost } = await unlockedChat();
    await vi.advanceTimersByTimeAsync(4_000);
    setIdleLockExtended(window, false);
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS - 4_000 - 1); // t = 9.999s
    expect(isFading(chatHost)).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // t = 10.000s — NOT 14s (the untick did not restart the clock)
    expect(isFading(chatHost)).toBe(true);
    panel.teardown();
  });

  it("unticking after the shorter deadline has already passed locks at once (no restart, no grace)", async () => {
    setIdleLockExtended(window, true);
    const { panel, chatHost } = await unlockedChat();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(isFading(chatHost)).toBe(false);
    setIdleLockExtended(window, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(isFading(chatHost)).toBe(true);
    panel.teardown();
  });

  it("changing the setting with no timer running (decoy) is harmless and starts nothing", async () => {
    const panel = mount();
    await flush(); // let the decoy's own async status poll settle first
    // jsdom itself queues a setTimeout(0) per localStorage write (its storage
    // event) — measure that overhead with an unrelated key so only the panel's
    // OWN reaction to the preference change is compared.
    const beforeControl = vi.getTimerCount();
    window.localStorage.setItem("unrelated-key", "1");
    window.localStorage.removeItem("unrelated-key");
    const storageOverhead = vi.getTimerCount() - beforeControl;

    const beforePreference = vi.getTimerCount();
    setIdleLockExtended(window, true);
    setIdleLockExtended(window, false);
    expect(vi.getTimerCount() - beforePreference).toBe(storageOverhead);
    panel.teardown();
  });

  it("real user activity restarts the full extended period", async () => {
    setIdleLockExtended(window, true);
    const { panel, chatHost } = await unlockedChat();
    await vi.advanceTimersByTimeAsync(50_000);
    document.dispatchEvent(new Event("pointermove", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_EXTENDED_MS - 1);
    expect(isFading(chatHost)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(isFading(chatHost)).toBe(true);
    panel.teardown();
  });

  it("a scroll event is still not activity when ticked — the original 60s window governs", async () => {
    setIdleLockExtended(window, true);
    const { panel, chatHost } = await unlockedChat();
    await vi.advanceTimersByTimeAsync(50_000);
    chatHost.dispatchEvent(new Event("scroll", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(isFading(chatHost)).toBe(true);
    panel.teardown();
  });

  it("a suspension pauses the extended timer, then restarts a FRESH full 60s on release", async () => {
    setIdleLockExtended(window, true);
    const chatFactory = trackedChatViewFactory();
    const { panel, chatHost } = await unlockedChat({ createServerChatView: chatFactory.createServerChatView });
    const hooks = chatFactory.hooks;
    if (hooks === null) throw new Error("hooks not captured");

    const release = hooks.suspend("recording");
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_EXTENDED_MS * 3); // must not fire while suspended
    expect(isFading(chatHost)).toBe(false);

    release();
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_EXTENDED_MS - 1); // not "whatever was left"
    expect(isFading(chatHost)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(isFading(chatHost)).toBe(true);
    panel.teardown();
  });

  it("a suspension ending after a mid-suspension tick restarts the NEW duration; the tick itself starts nothing", async () => {
    const chatFactory = trackedChatViewFactory();
    const { panel, chatHost } = await unlockedChat({ createServerChatView: chatFactory.createServerChatView });
    const hooks = chatFactory.hooks;
    if (hooks === null) throw new Error("hooks not captured");

    const release = hooks.suspend("mediaPlaying");
    await vi.advanceTimersByTimeAsync(20_000);
    setIdleLockExtended(window, true); // while suspended — must NOT start a timer
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_EXTENDED_MS * 2);
    expect(isFading(chatHost)).toBe(false);

    release();
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_EXTENDED_MS - 1);
    expect(isFading(chatHost)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(isFading(chatHost)).toBe(true);
    panel.teardown();
  });

  it("the decoy's 'Open server settings' re-hide stays 10s even when the box is ticked", async () => {
    setIdleLockExtended(window, true);
    const panel = mount();
    const affordance = panel.element.querySelector(".wx-srv-affordance") as HTMLElement;
    openAffordance(panel.element);
    expect(affordance.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS - 1);
    expect(affordance.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(affordance.hidden).toBe(true);
    panel.teardown();
  });

  it("the PIN pad's idle close stays 10s even when the box is ticked", async () => {
    setIdleLockExtended(window, true);
    const panel = mount();
    await openPinPad(panel.element);
    const pinPadHost = panel.element.querySelector(".wx-srv-pinpad-host") as HTMLElement;
    expect(pinPadHost.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS - 1);
    expect(pinPadHost.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pinPadHost.hidden).toBe(true);
    panel.teardown();
  });

  it("ticking while only the affordance/pin pad is up does not stretch their 10s", async () => {
    const panel = mount();
    const affordance = panel.element.querySelector(".wx-srv-affordance") as HTMLElement;
    openAffordance(panel.element);
    await vi.advanceTimersByTimeAsync(4_000);
    setIdleLockExtended(window, true);
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS - 4_000);
    expect(affordance.hidden).toBe(true);
    panel.teardown();
  });

  it("every other lock cause is unchanged when ticked: panic locks instantly, Escape locks instantly", async () => {
    setIdleLockExtended(window, true);
    const chatFactory = trackedChatViewFactory();
    const { panel } = await unlockedChat({ createServerChatView: chatFactory.createServerChatView });
    chatFactory.hooks?.lockNow("panic");
    expect(panel.element.querySelector(".wx-srv-thread")).toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok2", expiresAt: expiresIn(3600) }));
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");
    expect(panel.element.querySelector(".wx-srv-thread")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.element.querySelector(".wx-srv-thread")).toBeNull();
    panel.teardown();
  });

  it("the preference is read afresh on every unlock — a tick made while locked applies to the next unlock", async () => {
    const chatFactory = trackedChatViewFactory();
    const { panel, chatHost } = await unlockedChat({ createServerChatView: chatFactory.createServerChatView });
    chatFactory.hooks?.lockNow("panic");

    setIdleLockExtended(window, true);
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok2", expiresAt: expiresIn(3600) }));
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS * 3);
    expect(isFading(chatHost)).toBe(false);
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_EXTENDED_MS - IDLE_LOCK_MS * 3);
    expect(isFading(chatHost)).toBe(true);
    panel.teardown();
  });

  it("another tab's change (a storage event for the key) applies at once, from the last activity", async () => {
    const { panel, chatHost } = await unlockedChat();
    await vi.advanceTimersByTimeAsync(5_000);
    window.localStorage.setItem(IDLE_EXTENDED_KEY, "1");
    window.dispatchEvent(new StorageEvent("storage", { key: IDLE_EXTENDED_KEY, newValue: "1" }));
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_EXTENDED_MS - 5_000 - 1);
    expect(isFading(chatHost)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(isFading(chatHost)).toBe(true);
    panel.teardown();
  });

  it("teardown detaches the preference listeners (no leak after routing away)", async () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const panel = mount();
    panel.teardown();
    const removed = removeSpy.mock.calls.map(([type]) => type);
    expect(removed).toContain("wx-srv-idle-preference-changed");
    expect(removed).toContain("storage");
    removeSpy.mockRestore();
  });

  // -- R7 suspension accounting (fake clock) -------------------------------------

  it("a suspension pauses the idle timer entirely, then restarts it with a FRESH 10s on release", async () => {
    const chatFactory = trackedChatViewFactory();
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount({ createServerChatView: chatFactory.createServerChatView });
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");
    const chatHost = panel.element.querySelector(".wx-srv-chat-host") as HTMLElement;
    const hooks = chatFactory.hooks;
    if (hooks === null) throw new Error("hooks not captured");

    const release = hooks.suspend("recording");
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS * 3); // way past — must not fire while suspended
    expect(chatHost.classList.contains("wx-srv-fading")).toBe(false);
    expect(panel.element.querySelector(".wx-srv-thread")).not.toBeNull();

    release();
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS - 1); // not "whatever was left" — a fresh 10s
    expect(chatHost.classList.contains("wx-srv-fading")).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(chatHost.classList.contains("wx-srv-fading")).toBe(true);
    panel.teardown();
  });

  it("two concurrent suspensions both must release before the idle timer resumes", async () => {
    const chatFactory = trackedChatViewFactory();
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount({ createServerChatView: chatFactory.createServerChatView });
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");
    const chatHost = panel.element.querySelector(".wx-srv-chat-host") as HTMLElement;
    const hooks = chatFactory.hooks;
    if (hooks === null) throw new Error("hooks not captured");

    const releaseA = hooks.suspend("mediaPlaying");
    const releaseB = hooks.suspend("mediaPlaying");
    releaseA();
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS * 2); // still suspended via releaseB
    expect(chatHost.classList.contains("wx-srv-fading")).toBe(false);

    releaseB();
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS + 1);
    expect(chatHost.classList.contains("wx-srv-fading")).toBe(true);
    panel.teardown();
  });

  it("release() is idempotent — calling it twice never double-decrements the suspension count", async () => {
    const chatFactory = trackedChatViewFactory();
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount({ createServerChatView: chatFactory.createServerChatView });
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");
    const chatHost = panel.element.querySelector(".wx-srv-chat-host") as HTMLElement;
    const hooks = chatFactory.hooks;
    if (hooks === null) throw new Error("hooks not captured");

    const releaseA = hooks.suspend("mediaPlaying");
    const releaseB = hooks.suspend("mediaPlaying");
    releaseA();
    releaseA(); // double-release — must not also cancel releaseB's hold
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS + 1);
    expect(chatHost.classList.contains("wx-srv-fading")).toBe(false);

    releaseB();
    await vi.advanceTimersByTimeAsync(IDLE_LOCK_MS + 1);
    expect(chatHost.classList.contains("wx-srv-fading")).toBe(true);
    panel.teardown();
  });

  it("a filePicker suspension auto-releases after its 5-minute safety cap", async () => {
    const chatFactory = trackedChatViewFactory();
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount({ createServerChatView: chatFactory.createServerChatView });
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");
    const chatHost = panel.element.querySelector(".wx-srv-chat-host") as HTMLElement;
    const hooks = chatFactory.hooks;
    if (hooks === null) throw new Error("hooks not captured");
    hooks.suspend("filePicker"); // never manually released — an abandoned dialog

    await vi.advanceTimersByTimeAsync(PICKER_SUSPEND_MAX_MS + IDLE_LOCK_MS - 1);
    expect(chatHost.classList.contains("wx-srv-fading")).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(chatHost.classList.contains("wx-srv-fading")).toBe(true);
    panel.teardown();
  });

  it("recording/micPermission/mediaPlaying suspensions carry NO safety cap", async () => {
    const chatFactory = trackedChatViewFactory();
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount({ createServerChatView: chatFactory.createServerChatView });
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");
    const chatHost = panel.element.querySelector(".wx-srv-chat-host") as HTMLElement;
    const hooks = chatFactory.hooks;
    if (hooks === null) throw new Error("hooks not captured");
    hooks.suspend("recording");

    await vi.advanceTimersByTimeAsync(PICKER_SUSPEND_MAX_MS * 2);
    expect(chatHost.classList.contains("wx-srv-fading")).toBe(false);
    panel.teardown();
  });

  // -- Instance survival across lock/unlock, and real teardown -------------------

  it("the chat view instance is created once and REUSED across lock/unlock cycles", async () => {
    const chatFactory = trackedChatViewFactory();
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok-1", expiresAt: expiresIn(3600) }));
    const panel = mount({ createServerChatView: chatFactory.createServerChatView });

    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");
    expect(chatFactory.factoryCalls).toBe(1);
    expect(chatFactory.attachCalls).toHaveLength(1);
    expect(chatFactory.attachCalls[0]?.token).toBe("tok-1");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(chatFactory.detachCalls).toBe(1);
    expect(chatFactory.disposeCalls).toBe(0); // NOT disposed — only detached, still alive in memory

    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok-2", expiresAt: expiresIn(3600) }));
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");
    expect(chatFactory.factoryCalls).toBe(1); // still the SAME instance
    expect(chatFactory.attachCalls).toHaveLength(2);
    expect(chatFactory.attachCalls[1]?.token).toBe("tok-2"); // re-attached with a FRESH session

    panel.teardown();
    expect(chatFactory.disposeCalls).toBe(1); // real teardown disposes exactly once
  });

  it("teardown while chat is open locks (routeAway) and disposes the chat view", async () => {
    const chatFactory = trackedChatViewFactory();
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount({ createServerChatView: chatFactory.createServerChatView });
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");

    panel.teardown();

    expect(chatFactory.detachCalls).toBe(1);
    expect(chatFactory.disposeCalls).toBe(1);
  });

  it("teardown while still on the decoy never touches the chat view — it was never created", () => {
    const chatFactory = trackedChatViewFactory();
    const panel = mount({ createServerChatView: chatFactory.createServerChatView });
    panel.teardown();
    expect(chatFactory.factoryCalls).toBe(0);
    expect(chatFactory.disposeCalls).toBe(0);
  });

  // -- The DEFAULT stub (no createServerChatView override) — exercises the
  // real production stand-in `server-lock.spec.ts` (e2e) also drives, until
  // P5b's real chatView.ts replaces it at DM integration. --------------------

  it("the default stub's panic button locks instantly via hooks.lockNow('panic')", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok", expiresAt: expiresIn(3600) }));
    const panel = mount();
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");
    expect(panel.element.querySelector(".wx-srv-thread")).not.toBeNull();

    (panel.element.querySelector(".wx-srv-panic") as HTMLButtonElement).click();

    expect(panel.element.querySelector(".wx-srv-thread")).toBeNull();
    panel.teardown();
  });

  it("the default stub's instance (and its draft textarea) survives a lock/unlock cycle, not recreated", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok-1", expiresAt: expiresIn(3600) }));
    const panel = mount();
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");

    const draft = panel.element.querySelector<HTMLTextAreaElement>(".wx-srv-draft-stub");
    if (draft === null) throw new Error("draft textarea not found");
    draft.value = "unsent thought";
    const instanceIdBefore = panel.element.querySelector(".wx-srv-thread")?.getAttribute("data-stub-instance");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.element.querySelector(".wx-srv-thread")).toBeNull(); // detached, not just hidden

    fetchMock.mockResolvedValueOnce(jsonResponse({ token: "tok-2", expiresAt: expiresIn(3600) }));
    await openPinPad(panel.element);
    await enterAndSubmitPin(panel.element, "1234");

    const instanceIdAfter = panel.element.querySelector(".wx-srv-thread")?.getAttribute("data-stub-instance");
    expect(instanceIdAfter).toBe(instanceIdBefore); // the SAME instance — never recreated
    const draftAfter = panel.element.querySelector<HTMLTextAreaElement>(".wx-srv-draft-stub");
    expect(draftAfter?.value).toBe("unsent thought"); // the draft survived in memory
    panel.teardown();
  });
});
