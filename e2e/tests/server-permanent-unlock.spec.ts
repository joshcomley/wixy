// E2E for "Keep this device unlocked" and the two "lock when I…" checkboxes
// (spec/server-chat/03-permanent-unlock.md §1-§8), against the real wixy server with the
// fixture's fake cmd PIN service — the grant routes, the janitor-independent storage and the
// browser's own localStorage/reload behaviour are all real.
//
// `page.clock.install()` before every `goto`, as in server-lock.spec.ts: virtual time only
// moves on `runFor`, so two taps issued back to back read as 0 ms apart on `performance.now()`.
// That is exactly what proves the inline PIN pad is exempt from R3's multi-tap lock — its digit
// keys are tapped that fast, in a chat that would otherwise lock on the second tap.
//
// Chromium's real `IdleDetector` needs a permission prompt a headless run cannot answer, so an
// init script installs a stand-in with the same surface (`screenState`, `change`, a permission
// that starts at "prompt" and is granted by `requestPermission`). `fireScreenLock` drives it.

import { expect, test, type Browser, type Page } from "@playwright/test";
import { trackConsoleErrors } from "./helpers";

const TEST_PIN = "246813";
const WRONG_PIN = "000000";
const KEEP_LABEL = "Keep this device unlocked";
const TAB_LABEL = "Lock when I change tab";
const SCREEN_LABEL = "Lock when I lock my screen";
const GRANT_KEY = "wx-srv-device-grant";
const PAUSED_KEY = "wx-srv-grant-paused";
const PROVEN_KEY = "wx-srv-screenlock-proven";

interface DeviceProfile {
  readonly name: string;
  readonly viewport: { width: number; height: number };
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
}

const DEVICE_PROFILES: readonly DeviceProfile[] = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
  { name: "mobile", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
];

/** A stand-in for Chromium's Idle Detection API (see the file header). */
function installIdleDetectorStub(): void {
  const w = window as unknown as Record<string, unknown>;
  const permission = Object.assign(new EventTarget(), {
    name: "idle-detection",
    state: window.localStorage.getItem("__idle_permission") ?? "prompt",
  });
  class FakeIdleDetector extends EventTarget {
    screenState: "locked" | "unlocked" = "unlocked";
    userState: "active" | "idle" = "active";
    constructor() {
      super();
      w["__idleDetector"] = this;
    }
    static async requestPermission(): Promise<"granted"> {
      window.localStorage.setItem("__idle_permission", "granted");
      permission.state = "granted";
      permission.dispatchEvent(new Event("change"));
      return "granted";
    }
    async start(): Promise<void> {}
  }
  w["IdleDetector"] = FakeIdleDetector;
  const realQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (descriptor: PermissionDescriptor): Promise<PermissionStatus> =>
    (descriptor as { name: string }).name === "idle-detection"
      ? Promise.resolve(permission as unknown as PermissionStatus)
      : realQuery(descriptor);
}

async function withServerPage(
  browser: Browser,
  profile: DeviceProfile,
  fn: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({
    viewport: profile.viewport,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    deviceScaleFactor: profile.isMobile ? 3 : 1,
  });
  await context.addInitScript(installIdleDetectorStub);
  const page = await context.newPage();
  const errors = trackConsoleErrors(page);
  await page.clock.install();
  await page.goto("/admin/server");
  await page.waitForSelector(".wx-srv-decoy");
  await fn(page);
  expect(errors).toEqual([]);
  await context.close();
}

async function revealAndOpenPinPad(page: Page): Promise<void> {
  await page.locator(".wx-srv-decoy").click();
  await expect(page.locator(".wx-srv-affordance")).toBeVisible();
  await page.clock.runFor(401);
  await page.locator(".wx-srv-affordance").click();
  await expect(page.locator(".wx-srv-pinpad-title")).toHaveText("Unlock server");
}

async function enterNameIfPrompted(page: Page): Promise<void> {
  const prompt = page.locator(".wx-srv-name-prompt");
  await expect(page.locator(".wx-srv-name-prompt:visible, .wx-srv-thread:visible")).toBeVisible();
  if (!(await prompt.isVisible())) return;
  await page.locator(".wx-srv-name-prompt-input").fill("Tester");
  await page.locator(".wx-srv-name-prompt-button").click();
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await page.clock.runFor(401);
}

/** Types `pin` on whichever PIN pad `scope` names and waits for the real response to `path`. */
async function enterPinOn(page: Page, scope: string, pin: string, path: string): Promise<void> {
  const pad = page.locator(scope);
  for (const digit of pin) await pad.getByRole("button", { name: digit, exact: true }).click();
  const response = page.waitForResponse(
    (res) => res.url().endsWith(path) && res.request().method() === "POST",
    { timeout: 15_000 },
  );
  await pad.getByRole("button", { name: "✓", exact: true }).click();
  await response;
}

/** The unlock pad: reveals it, types the PIN, answers the first-unlock name prompt. */
async function unlockWithPin(page: Page): Promise<void> {
  await revealAndOpenPinPad(page);
  await enterPinOn(page, ".wx-srv-pinpad-host .wx-srv-pinpad", TEST_PIN, "/api/admin/server/unlock");
  await enterNameIfPrompted(page);
}

async function openSettings(page: Page): Promise<void> {
  await page.clock.runFor(401);
  await page.locator(".wx-srv-settings-button").click();
  await expect(page.locator(".wx-srv-sheet")).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  await page.clock.runFor(401);
  await page.locator(".wx-srv-sheet-close").click();
  await expect(page.locator(".wx-srv-sheet")).toBeHidden();
}

/** Ticks "Keep this device unlocked" and answers its inline PIN pad, then closes the sheet. */
async function keepDeviceUnlocked(page: Page): Promise<void> {
  await openSettings(page);
  await page.getByLabel(KEEP_LABEL).check();
  await expect(page.locator(".wx-srv-sheet-keep-pad .wx-srv-pinpad-title")).toHaveText(
    "Enter PIN to keep this device unlocked",
  );
  await enterPinOn(page, ".wx-srv-sheet-keep-pad .wx-srv-pinpad", TEST_PIN, "/api/admin/server/device-grants");
  await expect(page.locator(".wx-srv-sheet-keep-pad")).toBeHidden();
  await expect(page.locator(".wx-srv-sheet-keep-note")).toHaveText("On · Lock with the ✕ or a double-tap");
  await closeSettings(page);
}

async function setLockBoxes(page: Page, tab: boolean, screen: boolean): Promise<void> {
  await openSettings(page);
  // Order matters only in the sense that a tab-only change makes the boxes differ, which is
  // when the permission is asked for: the stub grants it on the spot.
  await page.getByLabel(TAB_LABEL).setChecked(tab);
  await page.getByLabel(SCREEN_LABEL).setChecked(screen);
  await expect(page.getByLabel(TAB_LABEL)).toBeChecked({ checked: tab });
  await expect(page.getByLabel(SCREEN_LABEL)).toBeChecked({ checked: screen });
  await closeSettings(page);
}

async function setVisibility(page: Page, state: "hidden" | "visible"): Promise<void> {
  await page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", { value: next, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

async function fireScreenLock(page: Page): Promise<void> {
  await page.evaluate(() => {
    const detector = (window as unknown as { __idleDetector?: EventTarget & { screenState: string } }).__idleDetector;
    if (detector === undefined) throw new Error("no IdleDetector was created — the permission was never granted");
    detector.screenState = "locked";
    detector.dispatchEvent(new Event("change"));
  });
}

async function reloadOnServerPage(page: Page): Promise<void> {
  await page.reload();
  await page.waitForSelector(".wx-srv-thread, .wx-srv-decoy:visible");
}

const chatIsOpen = (page: Page) => expect(page.locator(".wx-srv-thread")).toBeVisible();
const chatIsGone = (page: Page) => expect(page.locator(".wx-srv-thread")).toHaveCount(0);

for (const profile of DEVICE_PROFILES) {
  test.describe(`Server panel: keep this device unlocked — ${profile.name}`, () => {
    test.beforeEach(async ({ request }) => {
      await request.post("/test/server/reset-pin-lockout");
    });

    test(`${profile.name}: turn it on with the PIN, reload, and the chat opens with no PIN`, async ({ browser }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await keepDeviceUnlocked(page);
        // The rapid digit taps on the inline pad never counted as a multi-tap.
        await chatIsOpen(page);
        expect(await page.evaluate((key) => window.localStorage.getItem(key) !== null, GRANT_KEY)).toBe(true);

        await reloadOnServerPage(page);
        await chatIsOpen(page);
        await expect(page.locator(".wx-srv-pinpad-host")).toBeHidden();
        await expect(page.locator(".wx-srv-affordance")).toBeHidden();
      });
    });

    test(`${profile.name}: the stored grant is ids only in localStorage, never the unlock token`, async ({ browser }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await keepDeviceUnlocked(page);
        const stored = await page.evaluate(
          (keys) => keys.map((key) => [key, window.localStorage.getItem(key)] as const),
          [GRANT_KEY, "wx-srv-token", "wx-srv-session"],
        );
        const grant = JSON.parse(stored[0]?.[1] ?? "null") as { grantId: string; secret: string };
        expect(Object.keys(grant).sort()).toEqual(["grantId", "secret"]);
        expect(stored[1]?.[1]).toBeNull();
        expect(stored[2]?.[1]).toBeNull();
      });
    });

    test(`${profile.name}: with both lock boxes unticked, hiding the tab and two idle minutes leave it unlocked`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await keepDeviceUnlocked(page);
        await setLockBoxes(page, false, false);

        await setVisibility(page, "hidden");
        await page.clock.runFor(1_000);
        await setVisibility(page, "visible");
        await page.clock.runFor(1_000);
        await chatIsOpen(page);

        await page.clock.runFor(120_000);
        await chatIsOpen(page);
        await expect(page.locator(".wx-srv-chat-host")).not.toHaveClass(/wx-srv-fading/);
      });
    });

    test(`${profile.name}: with the boxes left ticked, hiding the tab locks and pauses it until the PIN`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await keepDeviceUnlocked(page);

        await setVisibility(page, "hidden");
        await chatIsGone(page);
        await setVisibility(page, "visible");
        expect(await page.evaluate((key) => window.localStorage.getItem(key), PAUSED_KEY)).toBe("1");

        await reloadOnServerPage(page);
        await chatIsGone(page);
        await expect(page.locator(".wx-srv-decoy")).toBeVisible();
      });
    });

    test(`${profile.name}: idle for two minutes never locks it (the default boxes only govern the background)`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await keepDeviceUnlocked(page);
        await page.clock.runFor(120_000);
        await chatIsOpen(page);
        await expect(page.locator(".wx-srv-chat-host")).not.toHaveClass(/wx-srv-fading/);
      });
    });

    test(`${profile.name}: panic locks it, a reload shows the decoy, the PIN unlocks it and it is permanent again`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await keepDeviceUnlocked(page);

        await page.locator('.wx-srv-chat-host button[aria-label="Close"]').click();
        await chatIsGone(page);
        expect(await page.evaluate((key) => window.localStorage.getItem(key), PAUSED_KEY)).toBe("1");

        await reloadOnServerPage(page);
        await chatIsGone(page);
        await expect(page.locator(".wx-srv-decoy")).toBeVisible();

        await unlockWithPin(page);
        await chatIsOpen(page);
        expect(await page.evaluate((key) => window.localStorage.getItem(key), PAUSED_KEY)).toBeNull();
        // The setting itself stayed on, so the very next reload opens it with no PIN.
        await reloadOnServerPage(page);
        await chatIsOpen(page);
      });
    });

    test(`${profile.name}: a double-tap in the chat locks it and pauses the grant too`, async ({ browser }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await keepDeviceUnlocked(page);
        await page.clock.runFor(401);
        // Two taps 0 ms apart on virtual time: R3's multi-tap.
        await page.locator(".wx-srv-thread").click();
        await page.locator(".wx-srv-thread").click();
        await chatIsGone(page);
        expect(await page.evaluate((key) => window.localStorage.getItem(key), PAUSED_KEY)).toBe("1");
        await reloadOnServerPage(page);
        await chatIsGone(page);
      });
    });

    test(`${profile.name}: Escape locks it and pauses the grant`, async ({ browser }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await keepDeviceUnlocked(page);
        await page.keyboard.press("Escape");
        await chatIsGone(page);
        await reloadOnServerPage(page);
        await chatIsGone(page);
      });
    });

    test(`${profile.name}: turning it off removes both keys and a reload shows the decoy`, async ({ browser }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await keepDeviceUnlocked(page);

        await openSettings(page);
        await page.getByLabel(KEEP_LABEL).uncheck();
        await expect(page.getByLabel(KEEP_LABEL)).not.toBeChecked();
        expect(
          await page.evaluate((keys) => keys.map((key) => window.localStorage.getItem(key)), [GRANT_KEY, PAUSED_KEY]),
        ).toEqual([null, null]);
        await closeSettings(page);

        await reloadOnServerPage(page);
        await chatIsGone(page);
        await expect(page.locator(".wx-srv-decoy")).toBeVisible();
      });
    });

    test(`${profile.name}: Sign out other devices revokes the grant and the next reload shows the decoy`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await keepDeviceUnlocked(page);

        await openSettings(page);
        const revoked = page.waitForResponse(
          (res) => res.url().endsWith("/api/admin/server/device-grants") && res.request().method() === "DELETE",
        );
        await page.getByRole("button", { name: "Sign out other devices" }).click();
        expect((await revoked).status()).toBe(204);
        await expect(page.locator(".wx-srv-sheet-signout-status")).toHaveText(/Done/);
        // This device's own grant went with the rest, so it turned itself off here too.
        await expect(page.getByLabel(KEEP_LABEL)).not.toBeChecked();
        await closeSettings(page);

        await reloadOnServerPage(page);
        await chatIsGone(page);
        await expect(page.locator(".wx-srv-decoy")).toBeVisible();
      });
    });

    test(`${profile.name}: a revoked grant is forgotten on the next open and shows the ordinary decoy`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await keepDeviceUnlocked(page);
        // Revoke it behind the device's back (the owner signed out from another phone).
        const grant = await page.evaluate((key) => window.localStorage.getItem(key), GRANT_KEY);
        expect(grant).not.toBeNull();
        await openSettings(page);
        await page.getByRole("button", { name: "Sign out other devices" }).click();
        await expect(page.locator(".wx-srv-sheet-signout-status")).toHaveText(/Done/);
        await closeSettings(page);
        // Put the (now revoked) grant back, as a stale second device would still hold it.
        await page.evaluate(([key, value]) => window.localStorage.setItem(key as string, value as string), [
          GRANT_KEY,
          grant,
        ]);

        await reloadOnServerPage(page);
        await chatIsGone(page);
        await expect(page.locator(".wx-srv-decoy")).toBeVisible();
        expect(await page.evaluate((key) => window.localStorage.getItem(key), GRANT_KEY)).toBeNull();
      });
    });

    test(`${profile.name}: a wrong PIN on the inline pad shows the attempts left and stores nothing`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await openSettings(page);
        await page.getByLabel(KEEP_LABEL).check();
        await enterPinOn(page, ".wx-srv-sheet-keep-pad .wx-srv-pinpad", WRONG_PIN, "/api/admin/server/device-grants");
        await expect(page.locator(".wx-srv-sheet-keep-pad .wx-srv-pinpad-message")).toHaveText("Wrong PIN — 4 attempts left");
        expect(await page.evaluate((key) => window.localStorage.getItem(key), GRANT_KEY)).toBeNull();
        // Cancel: the box goes back to unticked.
        await page.locator(".wx-srv-sheet-keep-pad .wx-srv-pinpad-cancel").click();
        await expect(page.getByLabel(KEEP_LABEL)).not.toBeChecked();
        await chatIsOpen(page);
      });
    });

    test(`${profile.name}: while it is on, "Extend auto-lock to 1 minute" is greyed out`, async ({ browser }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await keepDeviceUnlocked(page);
        await openSettings(page);
        await expect(page.getByLabel("Extend auto-lock to 1 minute")).toBeDisabled();
        await page.getByLabel(KEEP_LABEL).uncheck();
        await expect(page.getByLabel("Extend auto-lock to 1 minute")).toBeEnabled();
      });
    });
  });

  test.describe(`Server panel: lock when I change tab / lock my screen — ${profile.name}`, () => {
    test.beforeEach(async ({ request }) => {
      await request.post("/test/server/reset-pin-lockout");
    });

    test(`${profile.name}: both ticked by default, and the boxes store "0" only when unticked`, async ({ browser }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await openSettings(page);
        await expect(page.getByLabel(TAB_LABEL)).toBeChecked();
        await expect(page.getByLabel(SCREEN_LABEL)).toBeChecked();
        await page.getByLabel(TAB_LABEL).uncheck();
        await page.getByLabel(SCREEN_LABEL).uncheck();
        expect(
          await page.evaluate(() => [
            window.localStorage.getItem("wx-srv-lock-on-tab"),
            window.localStorage.getItem("wx-srv-lock-on-screen"),
          ]),
        ).toEqual(["0", "0"]);
        await page.getByLabel(TAB_LABEL).check();
        await page.getByLabel(SCREEN_LABEL).check();
        expect(
          await page.evaluate(() => [
            window.localStorage.getItem("wx-srv-lock-on-tab"),
            window.localStorage.getItem("wx-srv-lock-on-screen"),
          ]),
        ).toEqual([null, null]);
      });
    });

    test(`${profile.name}: both ticked — hiding the tab locks, as it always did`, async ({ browser }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await setVisibility(page, "hidden");
        await chatIsGone(page);
      });
    });

    test(`${profile.name}: both unticked — hiding the tab never locks (the idle timer still applies)`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await setLockBoxes(page, false, false);
        await setVisibility(page, "hidden");
        await page.clock.runFor(2_000);
        await setVisibility(page, "visible");
        await page.clock.runFor(600);
        await chatIsOpen(page);
        // No grant here, so the 10 s idle lock still ends it.
        await page.clock.runFor(11_000);
        await chatIsGone(page);
      });
    });

    test(`${profile.name}: tab ticked, screen unticked — a screen lock while away restores the chat`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await setLockBoxes(page, true, false);

        await setVisibility(page, "hidden");
        await chatIsGone(page); // fail closed while the cause is unknown
        await fireScreenLock(page);
        await setVisibility(page, "visible");
        await page.clock.runFor(600);
        await chatIsOpen(page);
        // The first screen lock seen while away proved this device reports them.
        expect(await page.evaluate((key) => window.localStorage.getItem(key), PROVEN_KEY)).toBe("1");
      });
    });

    test(`${profile.name}: tab ticked, screen unticked — a plain tab switch stays locked`, async ({ browser }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await setLockBoxes(page, true, false);
        await setVisibility(page, "hidden");
        await setVisibility(page, "visible");
        await page.clock.runFor(600);
        await chatIsGone(page);
        await expect(page.locator(".wx-srv-decoy")).toBeVisible();
      });
    });

    test(`${profile.name}: tab unticked, screen ticked, UNPROVEN device — a tab switch fails closed and the note says why`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await setLockBoxes(page, false, true);
        await openSettings(page);
        await expect(page.locator(".wx-srv-sheet-lockprefs-note")).toHaveText(
          "Lock your screen once so this phone can learn to tell a screen lock from a tab switch — until then, switching away also locks.",
        );
        await closeSettings(page);

        await setVisibility(page, "hidden");
        await setVisibility(page, "visible");
        await page.clock.runFor(600);
        await chatIsGone(page);
      });
    });

    test(`${profile.name}: tab unticked, screen ticked, PROVEN device — a tab switch restores, a screen lock stays locked`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await setLockBoxes(page, false, true);
        await page.evaluate((key) => window.localStorage.setItem(key, "1"), PROVEN_KEY);

        await setVisibility(page, "hidden");
        await setVisibility(page, "visible");
        await page.clock.runFor(600);
        await chatIsOpen(page); // no screen-lock event, proven device: it was a tab switch

        await setVisibility(page, "hidden");
        await fireScreenLock(page);
        await setVisibility(page, "visible");
        await page.clock.runFor(600);
        await chatIsGone(page);
      });
    });

    test(`${profile.name}: a screen lock while the page stays visible locks it when the screen box is ticked`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await setLockBoxes(page, false, true);
        await fireScreenLock(page);
        await chatIsGone(page);
      });
    });

    test(`${profile.name}: a screen lock while visible does nothing when the screen box is unticked`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockWithPin(page);
        await setLockBoxes(page, true, false);
        await fireScreenLock(page);
        await chatIsOpen(page);
      });
    });
  });
}

// The settings sheet must stay usable on the narrowest phone with the new rows in it: every
// checkbox row a full-width, 44px-tall tap target, the inline PIN pad inside the sheet's own
// scroll, and no horizontal overflow.
for (const layout of [
  { name: "narrow-phone", viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
] satisfies readonly DeviceProfile[]) {
  test(`settings sheet layout with the new rows — ${layout.name}`, async ({ browser, request }, testInfo) => {
    await request.post("/test/server/reset-pin-lockout");
    await withServerPage(browser, layout, async (page) => {
      await unlockWithPin(page);
      await openSettings(page);
      await page.getByLabel(KEEP_LABEL).check();

      const sheet = page.locator(".wx-srv-sheet");
      const box = await sheet.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.width ?? 0).toBeLessThanOrEqual(layout.viewport.width);
      for (const label of [KEEP_LABEL, TAB_LABEL, SCREEN_LABEL, "Extend auto-lock to 1 minute"]) {
        const row = page.locator(".wx-srv-sheet-idle", { hasText: label });
        const rowBox = await row.boundingBox();
        expect(rowBox?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect((rowBox?.x ?? 0) + (rowBox?.width ?? 0)).toBeLessThanOrEqual(layout.viewport.width);
      }
      const overflowsHorizontally = await sheet.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      expect(overflowsHorizontally).toBe(false);
      // The pad is reachable by scrolling the sheet, and its keys are real tap targets.
      const pad = page.locator(".wx-srv-sheet-keep-pad .wx-srv-pinpad");
      await pad.scrollIntoViewIfNeeded();
      await expect(pad).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`settings-keep-pad-${layout.name}.png`) });
    });
  });
}
