// E2E for the "Server" panel's lock/disguise/PIN-pad core (spec/server-chat/
// 00-brief.md §6, §11 — R2 gesture reading updated to v1.3 per operator
// decision #974: a SINGLE tap inside the panel reveals the affordance;
// multi-tap has no meaning there any more. R3 (multi-tap locks the chat
// view) is unchanged).
//
// Runs against P4's own stub `ServerChatView` (`.wx-srv-thread`, a
// `.wx-srv-draft-stub` textarea, a `.wx-srv-panic` button) — P5b's real
// thread view hasn't landed yet (wave 2); the stub deliberately honours the
// same class-name contract so every assertion here stays correct once the
// real view replaces it at DM integration.
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

import { expect, test, type Browser, type Page } from "@playwright/test";
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

async function enterPin(page: Page, pin: string): Promise<void> {
  const pad = page.locator(".wx-srv-pinpad");
  for (const digit of pin) {
    await pad.getByRole("button", { name: digit, exact: true }).click();
  }
  await pad.getByRole("button", { name: "✓", exact: true }).click();
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

    test(`${profile.name}: unlock — wrong PIN, 5-strike lockout with a live countdown, then the real PIN opens chat`, async ({
      browser,
      request,
    }) => {
      await withServerPage(browser, profile, async (page) => {
        await revealAndOpenPinPad(page);

        for (let attempt = 0; attempt < 4; attempt++) {
          await enterPin(page, WRONG_PIN);
          await expect(page.locator(".wx-srv-pinpad-message")).toHaveText("Incorrect PIN");
        }
        // The fake's default lockout_after is 5 — this trips it.
        await enterPin(page, WRONG_PIN);
        await expect(page.locator(".wx-srv-pinpad-message")).toContainText("Too many attempts");
        await expect(page.locator(".wx-srv-pinpad-message")).toContainText("try again in");

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
        await page.locator(".wx-srv-panic").click();
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
        const draft = page.locator(".wx-srv-draft-stub");
        await draft.click();
        await draft.click();
        await expect(page.locator(".wx-srv-thread")).toBeVisible();

        // Escape locks, even mid-typing in that same excluded textarea.
        await page.keyboard.press("Escape");
        await expect(page.locator(".wx-srv-thread")).toHaveCount(0);
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
        await page.locator(".wx-srv-draft-stub").fill("an unsent thought");

        await page.locator(".wx-srv-panic").click();
        await expect(page.locator(".wx-srv-thread")).toHaveCount(0);

        await revealAndOpenPinPad(page);
        await enterPin(page, TEST_PIN);
        await expect(page.locator(".wx-srv-draft-stub")).toHaveValue("an unsent thought");
      });
    });
  });
}
