// E2E for the "Server" panel's lock/disguise/PIN-pad core (spec/server-chat/
// 00-brief.md §6, §11 — R2 gesture reading updated to v1.3 per operator
// decision #974: a SINGLE tap inside the panel reveals the affordance;
// multi-tap has no meaning there any more. R3 (multi-tap locks the chat
// view) is unchanged).
//
// Runs against whichever `ServerChatView` is wired into the panel: P4's stub
// or P5b's real one. The selectors below (`.wx-srv-thread`, the chat host's
// textarea, its `aria-label="Close"` panic button) are valid for both. The
// real view's first-unlock name prompt is handled once, inside `enterPin`.
//
// `page.clock.install()` before every `goto` (per the brief's own e2e
// note): once installed, virtual time never advances between two
// Playwright actions unless `runFor`/`fastForward` is called, so two
// `.click()`s issued back-to-back always read as "0ms apart" on
// `performance.now()` — exactly what a real double-tap needs, with zero
// flake from IPC/network latency between commands.
//
// The fixture's PIN app (e2e/fixture_server.py) has its OWN real wall-clock
// lockout timer, independent of the browser's virtual clock — tripping it
// needs a real reset (`POST /test/server/reset-pin-lockout`), not just
// fast-forwarding the page.

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { trackConsoleErrors } from "./helpers";

// Matches e2e/fixture_server.py's TEST_SERVER_PIN / TEST_SERVER_PIN_APP_KEY.
const TEST_PIN = "246813";
const WRONG_PIN = "000000";

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
  const page = await context.newPage();
  const errors = trackConsoleErrors(page);
  await page.clock.install();
  await page.goto("/admin/server");
  await page.waitForSelector(".wx-srv-decoy");
  await fn(page);
  expect(errors).toEqual([]);
  await context.close();
}

/** Single tap (R2 v1.3) → advance past the 400ms reveal-affordance debounce
 * → tap the affordance for real → the pad is up, titled correctly. */
async function revealAndOpenPinPad(page: Page): Promise<void> {
  await page.locator(".wx-srv-decoy").click();
  await expect(page.locator(".wx-srv-affordance")).toBeVisible();
  await page.clock.runFor(401);
  await page.locator(".wx-srv-affordance").click();
  await expect(page.locator(".wx-srv-pinpad-title")).toHaveText("Unlock server");
}

/** Enters `pin` and submits, then explicitly waits for the real (unmocked)
 * `POST /unlock` response before returning — not just the click. This is
 * the actual backend call, with its own documented 5s timeout (§5.1); the
 * assertions callers make right after `enterPin` would otherwise be racing
 * that exact same window with Playwright's own 5000ms default `expect`
 * timeout, a zero-margin race a busy shared box can lose even when
 * everything is working correctly (found live: 12/20 tests flaked this way
 * when run alongside another heavy spec file on a loaded box, all at
 * exactly this boundary). Waiting on the network response directly removes
 * the race instead of just widening it. */
async function enterPin(page: Page, pin: string): Promise<void> {
  const pad = page.locator(".wx-srv-pinpad");
  for (const digit of pin) {
    await pad.getByRole("button", { name: digit, exact: true }).click();
  }
  const unlockResponse = page.waitForResponse(
    (res) => res.url().endsWith("/api/admin/server/unlock") && res.request().method() === "POST",
    { timeout: 15_000 },
  );
  await pad.getByRole("button", { name: "✓", exact: true }).click();
  await unlockResponse;
  if (pin === TEST_PIN) await enterNameIfPrompted(page);
}

/** The real chat view asks for a display name the first time a browser
 * unlocks (spec §6); once saved, later unlocks skip it, and the stub never
 * asks. Under `page.clock` a Continue tap and the next tap read as 0 ms apart
 * on `performance.now()` — R3's multi-tap — unless virtual time is advanced
 * past `MULTI_TAP_INTERVAL_MS` first. */
async function enterNameIfPrompted(page: Page): Promise<void> {
  const prompt = page.locator(".wx-srv-name-prompt");
  // `:visible` scopes each side to what is actually shown: the thread element
  // exists in the DOM (inside a hidden parent) while the name prompt is up.
  await expect(page.locator(".wx-srv-name-prompt:visible, .wx-srv-thread:visible")).toBeVisible();
  if (!(await prompt.isVisible())) return;
  await page.locator(".wx-srv-name-prompt-input").fill("Tester");
  await page.locator(".wx-srv-name-prompt-button").click();
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await page.clock.runFor(401);
}

const AUTO_LOCK_LABEL = "Extend auto-lock to 1 minute";

/** Opens the chat's settings sheet and returns its "Extend auto-lock to 1
 * minute" checkbox, found the way a person (and a screen reader) finds it: by
 * its label. Waits past R3's multi-tap window first so the gear tap and the
 * tap before it never read as a panic double-tap under `page.clock`. */
async function openSettingsAndFindAutoLockBox(page: Page): Promise<Locator> {
  await page.clock.runFor(401);
  await page.locator(".wx-srv-settings-button").click();
  await expect(page.locator(".wx-srv-sheet")).toBeVisible();
  return page.getByLabel(AUTO_LOCK_LABEL);
}

async function closeSettings(page: Page): Promise<void> {
  await page.clock.runFor(401);
  await page.locator(".wx-srv-sheet-close").click();
  await expect(page.locator(".wx-srv-sheet")).toBeHidden();
}

/** Unlocks into the chat, ticks (or unticks) the auto-lock box, and closes the
 * sheet — the close tap is the LAST user activity, so every clock assertion
 * after it counts from that instant. */
async function unlockAndSetAutoLock(page: Page, extended: boolean): Promise<void> {
  await revealAndOpenPinPad(page);
  await enterPin(page, TEST_PIN);
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  const box = await openSettingsAndFindAutoLockBox(page);
  await box.setChecked(extended);
  await closeSettings(page);
}

for (const profile of DEVICE_PROFILES) {
  test.describe(`Server panel lock/disguise — ${profile.name}`, () => {
    test.beforeEach(async ({ request }) => {
      // Defensive: earlier tests/files sharing this one fixture server must
      // never leave the fake's real-wall-clock lockout leaking into another
      // test's unlock attempt.
      await request.post("/test/server/reset-pin-lockout");
    });

    test(`${profile.name}: nav shows Server; the decoy shows real data; no affordance visible`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await expect(page.locator('[data-route-kind="server"]')).toBeVisible();
        await expect(page.locator('[data-route-kind="server"]')).toHaveText("Server");
        await expect(page.locator(".wx-srv-affordance")).toBeHidden();
        await expect(page.locator(".wx-srv-pinpad-host")).toBeHidden();
        // Real data, not filler — the skeleton resolves to an actual status.
        const statusRow = page.locator(".wx-srv-decoy-row", { hasText: "Status" });
        await expect(statusRow.locator(".wx-srv-decoy-value")).toHaveText("Online");
        await expect(statusRow.locator(".wx-srv-decoy-value")).not.toHaveClass(/wx-srv-decoy-skeleton/);
      });
    });

    test(`${profile.name}: R2 v1.3 — a SINGLE tap reveals the affordance; it re-hides after 10s idle`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await page.locator(".wx-srv-decoy").click();
        await expect(page.locator(".wx-srv-affordance")).toBeVisible();
        await page.clock.runFor(10_500);
        await expect(page.locator(".wx-srv-affordance")).toBeHidden();
      });
    });

    test(`${profile.name}: "not nav/topbar" — a tap outside the panel never reveals the affordance`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        // `.wx-topbar-title` doesn't exist at mobile widths (decisions/00107
        // — the topbar is gone entirely below ~720px) — the status bar
        // (decisions/00083) is the one chrome element that's ALWAYS visible
        // on every route/viewport, making it a reliable "outside the panel"
        // tap target for both legs.
        await page.locator(".wx-statusbar").click();
        await expect(page.locator(".wx-srv-affordance")).toBeHidden();
      });
    });

    test(`${profile.name}: a tap on the affordance WITHIN 400ms of the reveal is ignored`, async ({ browser }) => {
      await withServerPage(browser, profile, async (page) => {
        await page.locator(".wx-srv-decoy").click();
        await expect(page.locator(".wx-srv-affordance")).toBeVisible();
        // No clock advance — this click lands in the same virtual instant.
        await page.locator(".wx-srv-affordance").click();
        await expect(page.locator(".wx-srv-pinpad-host")).toBeHidden();
      });
    });

    test(`${profile.name}: unlock — wrong PIN attempts, 5-strike lockout, then the real PIN opens chat`, async ({
      browser,
      request,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await revealAndOpenPinPad(page);

        for (let attempt = 0; attempt < 4; attempt++) {
          await enterPin(page, WRONG_PIN);
          await expect(page.locator(".wx-srv-pinpad-message")).toHaveText(
            `Wrong PIN — ${4 - attempt} attempts left`,
          );
        }
        // The fake's default lockout_after is 5 — this trips it.
        await enterPin(page, WRONG_PIN);
        // The copy states cmd's REAL wait (the fake's 60 s lockout), not a canned
        // "2 minutes" (F15) — "1 minute" on the first paint, then seconds as it ticks.
        await expect(page.locator(".wx-srv-pinpad-message")).toHaveText(
          /^Too many wrong tries\. Try again in (1 minute|\d+ seconds?)\.$/,
        );
        await page.clock.runFor(3_000);
        const countdownText = (await page.locator(".wx-srv-pinpad-message").textContent()) ?? "";
        const secondsLeft = Number(/in (\d+) seconds?\./.exec(countdownText)?.[1]);
        expect(secondsLeft).toBeGreaterThan(0);
        expect(secondsLeft).toBeLessThan(60);

        // The pad itself is disabled while genuinely locked out — asserted
        // directly rather than via `enterPin` (a real, auto-RETRYING click
        // that would just hang until the test timeout, since a disabled
        // button never fires pointer events for it to eventually succeed).
        await expect(page.locator(".wx-srv-pinpad-key-submit")).toBeDisabled();
        await expect(page.locator(".wx-srv-thread")).toHaveCount(0);

        // Reset the fake's real-wall-clock lockout server-side. The pad's
        // OWN idle timer (still running throughout — R6/R7 apply to "pin"
        // same as any other unlocked-ish state) fires first regardless
        // (10s < the ~60s lockout), fading the whole panel back to the
        // decoy before the client-side countdown itself would ever clear —
        // a real, correct fail-closed behaviour: walking away mid-lockout
        // doesn't leave "Unlock server" sitting open indefinitely.
        await request.post("/test/server/reset-pin-lockout");
        await page.clock.runFor(11_000);
        await expect(page.locator(".wx-srv-pinpad-host")).toBeHidden();

        await revealAndOpenPinPad(page);
        await enterPin(page, TEST_PIN);
        await expect(page.locator(".wx-srv-thread")).toBeVisible();
      });
    });

    test(`${profile.name}: idle timing — 9s visible, activity extends it, locks ~10.8s after the LAST activity`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await revealAndOpenPinPad(page);
        await enterPin(page, TEST_PIN);
        await expect(page.locator(".wx-srv-thread")).toBeVisible();

        await page.clock.runFor(9_000);
        await expect(page.locator(".wx-srv-thread")).toBeVisible();

        await page.mouse.move(10, 10); // real pointer activity — extends idle
        await page.clock.runFor(9_000); // 9s since the move — still under 10s
        await expect(page.locator(".wx-srv-thread")).toBeVisible();

        // 10s idle + 800ms fade since the move — now locked and detached.
        await page.clock.runFor(1_900);
        await expect(page.locator(".wx-srv-thread")).toHaveCount(0);
        await expect(page.locator(".wx-srv-decoy")).toBeVisible();
      });
    });

    test(`${profile.name}: auto-lock box unticked (the default) — locks 10s after the last activity: fading at 10.5s, gone by 10.9s`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockAndSetAutoLock(page, false);
        const chatHost = page.locator(".wx-srv-chat-host");

        await page.clock.runFor(9_000);
        await expect(page.locator(".wx-srv-thread")).toBeVisible();
        await expect(chatHost).not.toHaveClass(/wx-srv-fading/);

        await page.clock.runFor(1_500); // t = 10.5s since the last activity
        await expect(chatHost).toHaveClass(/wx-srv-fading/);

        await page.clock.runFor(400); // t = 10.9s — the 800ms fade has finished
        await expect(page.locator(".wx-srv-thread")).toHaveCount(0);
        await expect(page.locator(".wx-srv-decoy")).toBeVisible();
      });
    });

    test(`${profile.name}: auto-lock box ticked — still unlocked at 10s and 59s, locking at 60.5s, gone by 60.9s`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockAndSetAutoLock(page, true);
        const chatHost = page.locator(".wx-srv-chat-host");

        await page.clock.runFor(10_500); // well past the normal 10s
        await expect(page.locator(".wx-srv-thread")).toBeVisible();
        await expect(chatHost).not.toHaveClass(/wx-srv-fading/);

        await page.clock.runFor(48_500); // t = 59s
        await expect(page.locator(".wx-srv-thread")).toBeVisible();
        await expect(chatHost).not.toHaveClass(/wx-srv-fading/);

        await page.clock.runFor(1_500); // t = 60.5s
        await expect(chatHost).toHaveClass(/wx-srv-fading/);

        await page.clock.runFor(400); // t = 60.9s — fade finished, detached
        await expect(page.locator(".wx-srv-thread")).toHaveCount(0);
        await expect(page.locator(".wx-srv-decoy")).toBeVisible();
      });
    });

    test(`${profile.name}: auto-lock box — the choice survives lock→unlock and a full reload; unticking restores 10s`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await unlockAndSetAutoLock(page, true);
        expect(await page.evaluate(() => window.localStorage.getItem("wx-srv-idle-extended"))).toBe("1");

        // Lock (panic) then unlock again: the box still reads ticked.
        await page.locator('.wx-srv-chat-host button[aria-label="Close"]').click();
        await expect(page.locator(".wx-srv-thread")).toHaveCount(0);
        await revealAndOpenPinPad(page);
        await enterPin(page, TEST_PIN);
        await expect(await openSettingsAndFindAutoLockBox(page)).toBeChecked();
        await closeSettings(page);

        // A full page reload: still ticked, and the 60s period governs the new page.
        await page.reload();
        await page.waitForSelector(".wx-srv-decoy");
        await revealAndOpenPinPad(page);
        await enterPin(page, TEST_PIN);
        await expect(await openSettingsAndFindAutoLockBox(page)).toBeChecked();
        await closeSettings(page);
        await page.clock.runFor(30_000);
        await expect(page.locator(".wx-srv-thread")).toBeVisible();

        // Unticking clears the stored key and puts the normal 10s back.
        const box = await openSettingsAndFindAutoLockBox(page);
        await box.uncheck();
        expect(await page.evaluate(() => window.localStorage.getItem("wx-srv-idle-extended"))).toBeNull();
        await closeSettings(page);
        await page.clock.runFor(10_500);
        await expect(page.locator(".wx-srv-chat-host")).toHaveClass(/wx-srv-fading/);
      });
    });

    test(`${profile.name}: auto-lock box — keyboard operable (Space toggles it) and toggling never locks the chat`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await revealAndOpenPinPad(page);
        await enterPin(page, TEST_PIN);
        const box = await openSettingsAndFindAutoLockBox(page);
        await expect(box).not.toBeChecked();
        await box.focus();
        await page.keyboard.press("Space");
        await expect(box).toBeChecked();
        await page.keyboard.press("Space");
        await expect(box).not.toBeChecked();
        // Two quick toggles (the same virtual instant) are not a panic double-tap.
        await expect(page.locator(".wx-srv-sheet")).toBeVisible();
        await expect(page.locator(".wx-srv-thread")).toBeVisible();
      });
    });

    test(`${profile.name}: a scroll event does NOT count as R7 activity — the chat still locks on schedule`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await revealAndOpenPinPad(page);
        await enterPin(page, TEST_PIN);
        // Synchronizes with the real (unmocked) unlock round-trip actually
        // completing — `runFor` below doesn't itself wait for anything, so
        // without this the clock could advance before the idle timer was
        // even armed.
        await expect(page.locator(".wx-srv-thread")).toBeVisible();

        await page.clock.runFor(9_000);
        await page.locator(".wx-srv-chat-host").evaluate((el) => {
          el.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        // If scroll had counted as activity this would still be well within
        // a fresh 10s; it must not — the ORIGINAL unlock-time idle window
        // (10s + 800ms fade) is what actually governs.
        await page.clock.runFor(1_900);
        await expect(page.locator(".wx-srv-thread")).toHaveCount(0);
      });
    });

    test(`${profile.name}: panic locks instantly; a double-tap on the thread locks; a double-tap in the draft does NOT; Escape locks`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        // Panic.
        await revealAndOpenPinPad(page);
        await enterPin(page, TEST_PIN);
        await page.locator('.wx-srv-chat-host button[aria-label="Close"]').click();
        await expect(page.locator(".wx-srv-thread")).toHaveCount(0);

        // R3: a double-tap anywhere in the chat view locks.
        await revealAndOpenPinPad(page);
        await enterPin(page, TEST_PIN);
        const thread = page.locator(".wx-srv-thread");
        await thread.click();
        await thread.click();
        await expect(page.locator(".wx-srv-thread")).toHaveCount(0);

        // R3's exclusion: a double-tap inside the draft textarea must not.
        await revealAndOpenPinPad(page);
        await enterPin(page, TEST_PIN);
        const draft = page.locator(".wx-srv-chat-host textarea");
        await draft.click();
        await draft.click();
        await expect(page.locator(".wx-srv-thread")).toBeVisible();

        // Escape locks, even mid-typing in that same excluded textarea.
        await page.keyboard.press("Escape");
        await expect(page.locator(".wx-srv-thread")).toHaveCount(0);
      });
    });

    test(`${profile.name}: PIN-pad taps leave no leftover multi-tap count — ONE genuine tap in chat right after unlock never locks`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        // Regression: R3's multiTapDetector is attached to `document` for
        // the panel's whole mounted lifetime, and `isExcludedTapTarget`
        // excludes textarea/input/contenteditable/audio/video — NOT the PIN
        // pad's own <button> elements, so every PIN-entry tap feeds the SAME
        // detector R3 uses inside chat and can leave it holding a leftover
        // count (parity depends on exactly how many taps PIN entry took —
        // one extra qualifying tap here forces the odd-leftover case
        // deterministically, matching a real user who e.g. brushed the pad
        // once more than the digits alone would). Previously that leftover
        // count could combine with the very first tap made inside the
        // just-unlocked chat view to spuriously complete a "multi-tap" and
        // instantly re-lock a chat that was only just opened.
        await revealAndOpenPinPad(page);
        await page
          .locator(".wx-srv-pinpad")
          .evaluate((el) => el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
        await enterPin(page, TEST_PIN);
        await expect(page.locator(".wx-srv-thread")).toBeVisible();

        await page.locator(".wx-srv-thread").click();

        await expect(page.locator(".wx-srv-thread")).toBeVisible();
      });
    });

    test(`${profile.name}: routing away and back locks; a reload locks; a synthetic hidden event locks`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        // SPA routing away and back — a fresh mount always starts at decoy.
        await revealAndOpenPinPad(page);
        await enterPin(page, TEST_PIN);
        await page.locator('[data-route-kind="pages"]').click();
        await page.waitForSelector(".wx-pages-table");
        await page.locator('[data-route-kind="server"]').click();
        await page.waitForSelector(".wx-srv-decoy");
        await expect(page.locator(".wx-srv-thread")).toHaveCount(0);
        await expect(page.locator(".wx-srv-affordance")).toBeHidden();

        // A page reload — unlock state is never persisted.
        await revealAndOpenPinPad(page);
        await enterPin(page, TEST_PIN);
        await expect(page.locator(".wx-srv-thread")).toBeVisible();
        await page.reload();
        await page.waitForSelector(".wx-srv-decoy");
        await expect(page.locator(".wx-srv-thread")).toHaveCount(0);

        // The tab becoming hidden.
        await revealAndOpenPinPad(page);
        await enterPin(page, TEST_PIN);
        await expect(page.locator(".wx-srv-thread")).toBeVisible();
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await expect(page.locator(".wx-srv-thread")).toHaveCount(0);
      });
    });

    test(`${profile.name}: a draft survives a lock/unlock cycle — type, panic, unlock, the text is restored`, async ({
      browser,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await revealAndOpenPinPad(page);
        await enterPin(page, TEST_PIN);
        await page.locator(".wx-srv-chat-host textarea").fill("an unsent thought");

        await page.locator('.wx-srv-chat-host button[aria-label="Close"]').click();
        await expect(page.locator(".wx-srv-thread")).toHaveCount(0);

        await revealAndOpenPinPad(page);
        await enterPin(page, TEST_PIN);
        await expect(page.locator(".wx-srv-chat-host textarea")).toHaveValue("an unsent thought");
      });
    });
  });
}

// The settings-sheet checkbox must be usable on the narrowest phone: a real
// label, a row at least 44px tall, and text that WRAPS instead of truncating
// or spilling out of the sheet. 375px is the classic small iPhone; 1280px is
// desktop. Each run also leaves a screenshot in the test's output folder.
const LAYOUT_PROFILES: readonly DeviceProfile[] = [
  { name: "narrow-phone", viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
];

for (const profile of LAYOUT_PROFILES) {
  test(`auto-lock box layout at ${profile.viewport.width}px: labelled, at least 44px tall, wraps, fits the sheet`, async ({
    browser,
  }, testInfo) => {
    await withServerPage(browser, profile, async (page) => {
      await revealAndOpenPinPad(page);
      await enterPin(page, TEST_PIN);
      const box = await openSettingsAndFindAutoLockBox(page);
      await expect(box).toBeVisible();
      await expect(box).toHaveAccessibleName(AUTO_LOCK_LABEL);

      const rowBox = await page.locator(".wx-srv-sheet-idle-row").boundingBox();
      const sheetBox = await page.locator(".wx-srv-sheet").boundingBox();
      if (rowBox === null || sheetBox === null) throw new Error("sheet or row not laid out");
      expect(rowBox.height).toBeGreaterThanOrEqual(44);
      // Inside the sheet horizontally — never spilling past its edges.
      expect(rowBox.x).toBeGreaterThanOrEqual(sheetBox.x - 0.5);
      expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(sheetBox.x + sheetBox.width + 0.5);
      // The text is never clipped: its content fits its own box.
      const text = page.locator(".wx-srv-sheet-idle-row .wx-srv-sheet-idle-text");
      await expect(text).toHaveText(AUTO_LOCK_LABEL);
      expect(await text.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
      // The sheet adds no sideways page scroll.
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1),
      ).toBe(false);

      await page.screenshot({ path: testInfo.outputPath(`auto-lock-sheet-${profile.viewport.width}.png`) });
    });
  });
}

// The settings sheet on a real ANDROID phone. Android is where the optional push
// row ALSO renders, making the sheet its tallest; the sheet used to be a
// content-height box anchored to the bottom of its host, so on a short viewport
// (<= ~668px tall portrait, or any landscape phone) it grew UPWARD past the top
// of the host and its close X ended up underneath the admin's own navigation,
// unreachable — with the sheet covering the whole host in portrait there is no
// dim margin to tap either. The fix keeps the sheet inside its host, scrolls its
// body internally and pins the header (with the X) to the top. These cases use an
// Android user agent plus push capability stubs (the same shape as
// server-push.spec.ts) so the push row really renders, and hit-test the controls
// with `elementFromPoint` — a screenshot on a non-Android profile could never
// see this.
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36";

const ANDROID_VIEWPORTS: readonly { width: number; height: number }[] = [
  { width: 360, height: 800 },
  { width: 360, height: 668 },
  { width: 360, height: 640 },
  { width: 360, height: 600 },
  { width: 360, height: 560 }, // already broken on main before the auto-lock row existed
  { width: 640, height: 360 }, // landscape
];

async function withAndroidServerPage(
  browser: Browser,
  viewport: { width: number; height: number },
  fn: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({
    userAgent: ANDROID_UA,
    viewport,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const errors = trackConsoleErrors(page);
  await page.addInitScript(() => {
    // Just enough of the Web Push surface for `isAndroidPushCapable` to be true
    // and the toggle to render, exactly as on a real Android Chrome.
    const subscription = {
      toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/t", keys: { p256dh: "p", auth: "a" } }),
      unsubscribe: async () => true,
    };
    const registration = {
      pushManager: { subscribe: async () => subscription, getSubscription: async () => null },
      unregister: async () => true,
    };
    Object.defineProperty(window, "PushManager", { configurable: true, value: class PushManager {} });
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: { permission: "default", requestPermission: async () => "granted" },
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: async () => registration, ready: Promise.resolve(registration) },
    });
  });
  await page.clock.install();
  await page.goto("/admin/server");
  await page.waitForSelector(".wx-srv-decoy");
  await fn(page);
  expect(errors).toEqual([]);
  await context.close();
}

interface ReachReport {
  readonly inViewport: boolean;
  readonly hitsItself: boolean;
  readonly box: { top: number; bottom: number; left: number; right: number };
  readonly viewport: { width: number; height: number };
}

/** Where `selector` sits right now and whether a real pointer at its centre would
 * land on it (not on whatever is stacked over it). No scrolling is done here. */
async function reach(page: Page, selector: string): Promise<ReachReport> {
  return page.locator(selector).evaluate((el): ReachReport => {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    return {
      inViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= viewport.height && rect.right <= viewport.width,
      hitsItself: hit !== null && el.contains(hit),
      box: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      viewport,
    };
  });
}

for (const viewport of ANDROID_VIEWPORTS) {
  test(`android settings sheet at ${viewport.width}x${viewport.height}: push row shown; the X stays reachable and the Delete/Lock controls scroll into reach`, async ({
    browser,
  }, testInfo) => {
    await withAndroidServerPage(browser, viewport, async (page) => {
      await revealAndOpenPinPad(page);
      await enterPin(page, TEST_PIN);
      await openSettingsAndFindAutoLockBox(page);
      // Proves this really is the Android-shaped (tallest) sheet.
      await expect(page.locator(".wx-srv-push-toggle")).toBeVisible();
      await expect(page.getByLabel(AUTO_LOCK_LABEL)).toBeVisible();

      const sheet = ".wx-srv-sheet";
      const close = ".wx-srv-sheet-close";

      // The sheet never outgrows its host: it stays inside the dimmed backdrop that
      // fills the host (this is what used to break — it spilled above the host's top
      // edge), and its top is on screen. (A landscape phone's host can itself run
      // below the fold, so "the whole sheet is in the viewport" is not the invariant.)
      const containment = await page.evaluate(() => {
        const sheetRect = document.querySelector(".wx-srv-sheet")?.getBoundingClientRect();
        const backdropRect = document.querySelector(".wx-srv-sheet-backdrop")?.getBoundingClientRect();
        if (sheetRect === undefined || backdropRect === undefined) return null;
        return {
          sheetTop: sheetRect.top,
          sheetBottom: sheetRect.bottom,
          backdropTop: backdropRect.top,
          backdropBottom: backdropRect.bottom,
        };
      });
      if (containment === null) throw new Error("sheet or backdrop missing");
      expect(containment.sheetTop, `sheet ${JSON.stringify(containment)}`).toBeGreaterThanOrEqual(0);
      expect(containment.sheetTop, `sheet ${JSON.stringify(containment)}`).toBeGreaterThanOrEqual(containment.backdropTop - 0.5);
      expect(containment.sheetBottom, `sheet ${JSON.stringify(containment)}`).toBeLessThanOrEqual(containment.backdropBottom + 0.5);

      // The X is reachable straight away, with no scrolling.
      const closeAtRest = await reach(page, close);
      expect(closeAtRest.inViewport, `X box ${JSON.stringify(closeAtRest.box)} in ${JSON.stringify(closeAtRest.viewport)}`).toBe(true);
      expect(closeAtRest.hitsItself, "the X is covered by another element").toBe(true);

      await page.screenshot({ path: testInfo.outputPath(`android-sheet-${viewport.width}x${viewport.height}-top.png`) });

      // Scroll the sheet's own contents to the very bottom: the X is still pinned in
      // reach, and the last controls (Delete all messages, Lock) can be brought
      // into reach and hit-tested.
      await page.locator(sheet).evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await page.screenshot({ path: testInfo.outputPath(`android-sheet-${viewport.width}x${viewport.height}-bottom.png`) });
      const closeAfterScroll = await reach(page, close);
      expect(closeAfterScroll.inViewport).toBe(true);
      expect(closeAfterScroll.hitsItself, "the X is covered once the sheet is scrolled").toBe(true);
      for (const selector of [".wx-srv-sheet-wipe", ".wx-srv-sheet-lock"]) {
        await page.locator(selector).scrollIntoViewIfNeeded();
        const report = await reach(page, selector);
        expect(report.inViewport, `${selector} box ${JSON.stringify(report.box)}`).toBe(true);
        expect(report.hitsItself, `${selector} is covered by another element`).toBe(true);
      }

      // And a real pointer can actually close it.
      await page.clock.runFor(401);
      await page.locator(close).click();
      await expect(page.locator(sheet)).toBeHidden();
    });
  });
}
