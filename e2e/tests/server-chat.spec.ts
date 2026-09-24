// E2E for the Server chat's message view (spec/server-chat/00-brief.md §10
// P5b, §11's e2e matrix). Assumes P4's lock/decoy/PIN-pad and this parcel's
// real `createServerChatView` are both wired in (DM integration) — before
// that, `mountServerPanel`'s default stub shows "Server chat is coming
// soon." with no first-unlock name prompt, and every spec here fails at the
// `.wx-srv-name-prompt` assertion in `unlockServer`.
//
// Every helper/assertion here was verified against the REAL, integrated
// stack (P1's backend + P4's real lock UI + this parcel) during development,
// not just against mocks — that pass caught a genuine bug this file's own
// "A -> B live delivery" test pins: `send()` originally built `clientId` as
// `${deviceId}:${uuid}` (73 chars), silently exceeding §5.3's 8-64 char
// bound on EVERY send (masked by the optimistic echo, which paints
// regardless of whether the network call ever succeeds) — see
// serverThread.test.ts's own regression test for the unit-level pin.
//
// This fixture server runs ONE project for the whole spec FILE
// (playwright.config.ts: `workers: 1`, no per-test reset — the suite's own
// established convention), so every seeded batch below carries a `label`
// unique to its own test rather than asserting an absolute thread-wide
// count, which a sibling test's leftover rows would silently corrupt.

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { trackConsoleErrors } from "./helpers";

/** Mirrors `MULTI_TAP_INTERVAL_MS` in admin-ui/src/server/constants.ts. */
const MULTI_TAP_INTERVAL_MS = 400;

async function unlockServer(page: Page, name: string): Promise<void> {
  const configResponse = await page.request.post("/test/server/config");
  const { pin } = (await configResponse.json()) as { pin: string };

  // Deep-link straight to the panel rather than loading /admin/pages and clicking
  // the nav item: the shell re-renders the current route once its first
  // /api/admin/state answers (shell.ts loadState → handleRoute), which tears down
  // the panel the click just mounted — and any tap on it. On a slow or busy machine
  // that lands after the test's first tap (measured: `MOUNT#1 | tap:decoy>revealed |
  // TEARDOWN#1 | lock:routeAway | MOUNT#2`), leaving a fresh decoy with a hidden
  // button. A deep link renders the route exactly once. (server-lock.spec.ts does
  // the same; nav-click behaviour is covered there.)
  await page.goto("/admin/server");
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  await expect(page.locator(".wx-srv-affordance")).toBeHidden();

  await page.locator(".wx-srv-panel").click();
  await expect(page.locator(".wx-srv-affordance")).toBeVisible();
  // R2 v1.3's 400ms reveal-affordance debounce (decision #974) — a tap on
  // the button within this window of the tap that revealed it doesn't open
  // the pad.
  await page.waitForTimeout(500);
  await page.locator(".wx-srv-affordance").click();
  await expect(page.locator(".wx-srv-pinpad")).toBeVisible();

  for (const digit of pin) {
    await page.locator(`.wx-srv-pinpad-key-digit:text-is("${digit}")`).click();
  }
  await page.locator(".wx-srv-pinpad-key-submit").click();

  const namePrompt = page.locator(".wx-srv-name-prompt");
  await expect(page.locator(".wx-srv-name-prompt:visible, .wx-srv-thread:visible")).toBeVisible({
    timeout: 5000,
  });
  if (await namePrompt.isVisible()) {
    // Nothing may be sent before a name exists: the thread view (header, thread,
    // composer) must stay hidden behind the prompt. Only a real browser can prove
    // it — `[hidden]` loses to a class's own `display` (see serverChatCss.test.ts).
    await expect(page.locator(".wx-srv-thread-view")).toBeHidden();
    await page.locator(".wx-srv-name-prompt-input").fill(name);
    await page.locator(".wx-srv-name-prompt-button").click();
  }
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await expect(page.locator(".wx-srv-name-prompt")).toBeHidden();
  // R3 (spec §6): two taps inside the chat view less than MULTI_TAP_INTERVAL_MS
  // apart lock the panel instantly. Playwright will otherwise tap Send within a
  // few ms of the Continue tap above — far faster than any person — and trip that
  // panic gesture (measured live: `multiTap chat->decoy` on the Send click, ~2.5s
  // after page load, nowhere near R7's 10s idle limit). Let the window elapse so
  // the tests exercise a human tap cadence, not the panic gesture.
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

async function seed(
  page: Page,
  opts: { count: number; label: string; sender?: string; startAgoS?: number; spreadS?: number },
): Promise<void> {
  await page.request.post("/test/server/seed-messages", {
    data: { sender: "Fixture", spreadS: 0, ...opts },
  });
}

/** R6/R7: a real device isn't perfectly still for the 10s idle-lock window
 * while this test drives a SECOND, much slower context — a light touch
 * (a real pointermove, R7's own activity signal) keeps `page` from locking
 * out from under an assertion that's polling `other`. */
async function keepAlive(page: Page): Promise<void> {
  await page.mouse.move(Math.random() * 100, Math.random() * 100);
}

async function waitVisible(locator: ReturnType<Page["locator"]>, keepAlivePage: Page): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await keepAlive(keepAlivePage);
    if (await locator.first().isVisible().catch(() => false)) return;
    await keepAlivePage.waitForTimeout(500);
  }
  await expect(locator).toBeVisible({ timeout: 3000 });
}

async function browserTokenSurfaces(page: Page): Promise<string> {
  const pageState = await page.evaluate(() => ({
    url: window.location.href,
    historyState: window.history.state,
    localStorage: Object.fromEntries(Object.entries(window.localStorage)),
    sessionStorage: Object.fromEntries(Object.entries(window.sessionStorage)),
    documentCookie: document.cookie,
    resourceUrls: performance.getEntriesByType("resource").map((entry) => entry.name),
    dom: document.documentElement.outerHTML,
  }));
  return JSON.stringify({ pageState, cookies: await page.context().cookies() });
}

async function browserSignals(page: Page): Promise<{
  title: string;
  icons: string[];
  serverNav: string | null;
  badges: string[];
}> {
  return page.evaluate(() => {
    const serverNav = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Server");
    return {
      title: document.title,
      icons: Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'))
        .map((link) => link.href),
      serverNav: serverNav?.outerHTML ?? null,
      badges: Array.from(document.querySelectorAll<HTMLElement>(
        '[class*="badge"], [aria-label*="unread" i], [data-unread]',
      )).map((element) => element.outerHTML),
    };
  });
}

test.describe("server-chat.spec.ts (P5b)", () => {
  test("A -> B live delivery within 3s, correct alignment, and echo reconciliation", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errorsA = trackConsoleErrors(pageA);
    const errorsB = trackConsoleErrors(pageB);

    // The fixture server (one project per spec file, no per-test reset) keeps every
    // row a previous run left behind, so this run's texts carry a unique tag — a
    // fixed string would match the old rows and trip Playwright's strict mode.
    const tag = `live-delivery-${Date.now()}`;
    const helloText = `${tag}: hello from Josh`;
    const replyText = `${tag}: reply from Purdy`;

    await unlockServer(pageA, "Josh");
    await unlockServer(pageB, "Purdy");

    await pageA.locator(".wx-srv-thread-view textarea").fill(helloText);
    await pageA.locator(".wx-srv-thread-view .wx-chat-send-button").click();

    // The echo paints instantly, then reconciles into the one real bubble —
    // never both at once.
    const ownBubble = pageA.locator(".wx-srv-bubble-mine").filter({ hasText: helloText });
    await expect(ownBubble).toBeVisible();
    await expect(pageA.locator(".wx-srv-echo")).toBeHidden({ timeout: 3000 });
    expect(await ownBubble.count()).toBe(1);

    const bOwn = pageB.locator(".wx-srv-bubble-theirs").filter({ hasText: helloText });
    await waitVisible(bOwn, pageB);
    await expect(bOwn).toBeVisible({ timeout: 3000 });
    await expect(pageB.locator(".wx-srv-bubble-sender").filter({ hasText: "Josh" })).toBeVisible();

    await keepAlive(pageA);
    // B has been passive while A acted; a fresh touch keeps R7's 10s idle timer from
    // firing on a slow machine, mirroring what keepAlive(pageA) does for A's wait.
    await keepAlive(pageB);
    await pageB.locator(".wx-srv-thread-view textarea").fill(replyText);
    await pageB.locator(".wx-srv-thread-view .wx-chat-send-button").click();

    const aReply = pageA.locator(".wx-srv-bubble-theirs").filter({ hasText: replyText });
    await waitVisible(aReply, pageA);
    await expect(aReply).toBeVisible({ timeout: 3000 });

    expect(errorsA, `console errors on page A: ${errorsA.join("; ")}`).toEqual([]);
    expect(errorsB, `console errors on page B: ${errorsB.join("; ")}`).toEqual([]);

    await contextA.close();
    await contextB.close();
  });

  test("unlock token never enters browser storage, cookies, history or URLs", async ({ page }) => {
    await page.goto("/admin/server");
    const beforeUnlock = await browserTokenSurfaces(page);
    const unlockResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/admin/server/unlock") && response.request().method() === "POST",
    );
    await unlockServer(page, "Token tester");
    const body = (await unlockResponse).json() as Promise<{ token: string }>;
    const token = (await body).token;
    expect(token).toBeTruthy();

    expect(beforeUnlock).not.toContain(token);
    expect(await browserTokenSurfaces(page)).not.toContain(token);
    await page.locator('.wx-srv-chat-host button[aria-label="Close"]').click();
    await expect(page.locator(".wx-srv-decoy")).toBeVisible();
    expect(await browserTokenSurfaces(page)).not.toContain(token);
  });

  test("saving a settings name updates local storage and survives reload/unlock", async ({ page }) => {
    await unlockServer(page, "Original name");
    await page.locator(".wx-srv-settings-button").click();
    await page.locator(".wx-srv-sheet-name-input").fill("Saved name");
    await page.locator(".wx-srv-sheet-save-name").click();

    await expect(page.locator(".wx-srv-name-chip")).toHaveText("Saved name");
    expect(await page.evaluate(() => localStorage.getItem("wx-srv-name"))).toBe("Saved name");
    await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
    await page.reload();
    await unlockServer(page, "Ignored after saved name");
    await expect(page.locator(".wx-srv-name-chip")).toHaveText("Saved name");
    expect(await page.evaluate(() => localStorage.getItem("wx-srv-name"))).toBe("Saved name");
  });

  test("incoming messages do not change the title, favicon or nav badge while locked or unlocked", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const tag = `no-unread-signal-${Date.now()}`;
    try {
      await unlockServer(pageA, "Signal A");
      await unlockServer(pageB, "Signal B");
      await pageA.locator('.wx-srv-chat-host button[aria-label="Close"]').click();
      await expect(pageA.locator(".wx-srv-decoy")).toBeVisible();
      const lockedSignals = await browserSignals(pageA);

      const lockedText = `${tag}: while locked`;
      await pageB.locator(".wx-srv-thread-view textarea").fill(lockedText);
      await pageB.locator(".wx-srv-thread-view .wx-chat-send-button").click();
      await expect(pageB.locator(".wx-srv-bubble-mine").filter({ hasText: lockedText })).toBeVisible();
      expect(await browserSignals(pageA)).toEqual(lockedSignals);

      await unlockServer(pageA, "Signal A");
      const unlockedSignals = await browserSignals(pageA);
      const unlockedText = `${tag}: while unlocked`;
      await keepAlive(pageA);
      await pageB.locator(".wx-srv-thread-view textarea").fill(unlockedText);
      await pageB.locator(".wx-srv-thread-view .wx-chat-send-button").click();
      await waitVisible(pageA.locator(".wx-srv-bubble-theirs").filter({ hasText: unlockedText }), pageA);
      expect(await browserSignals(pageA)).toEqual(unlockedSignals);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test("desktop right-click opens message actions without locking the chat", async ({ page }) => {
    const label = `right-click-${Date.now()}`;
    await seed(page, { count: 1, label, sender: "Purdy" });
    await unlockServer(page, "Context tester");
    const bubble = page.locator(".wx-srv-bubble").filter({ hasText: `${label} #1` });
    await expect(bubble).toBeVisible();
    await bubble.dispatchEvent("contextmenu", { button: 2, bubbles: true, cancelable: true });
    await expect(bubble.locator(".wx-srv-message-actions")).toBeVisible();
    await expect(bubble.getByRole("menuitem", { name: "Delete for everyone" })).toBeVisible();
    await expect(bubble.getByRole("menuitem", { name: "Copy text" })).toBeVisible();
    await expect(page.locator(".wx-srv-thread")).toBeVisible();
  });

  test("the settings Lock button detaches the thread and returns to the decoy", async ({ page }) => {
    await unlockServer(page, "Lock button tester");
    await page.locator(".wx-srv-settings-button").click();
    await page.locator(".wx-srv-sheet-lock").click();
    await expect(page.locator(".wx-srv-thread")).toHaveCount(0);
    await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  });

  test("history paging over 120 seeded messages, with a day separator", async ({ page }) => {
    await seed(page, {
      count: 120,
      label: "Paging test",
      // spreadS=900 (15min) x 120 = 30h total span, guaranteed to cross at
      // least one calendar-day boundary regardless of the local "now".
      startAgoS: 172_800,
      spreadS: 900,
    });
    const errors = trackConsoleErrors(page);

    await unlockServer(page, "Tester");

    await expect(page.locator(".wx-srv-bubble-text").filter({ hasText: /^Paging test #120$/ })).toBeVisible();
    const initialCount = await page.locator(".wx-srv-bubble-text").filter({ hasText: /^Paging test #/ }).count();
    expect(initialCount).toBeLessThan(120); // only the newest page loaded initially

    for (let i = 0; i < 8; i++) {
      await page.locator(".wx-srv-thread").evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.waitForTimeout(400);
      if (await page.locator(".wx-srv-bubble-text").filter({ hasText: /^Paging test #1$/ }).isVisible().catch(() => false)) {
        break;
      }
    }

    await expect(page.locator(".wx-srv-bubble-text").filter({ hasText: /^Paging test #1$/ })).toBeVisible({
      timeout: 5000,
    });
    const finalCount = await page.locator(".wx-srv-bubble-text").filter({ hasText: /^Paging test #/ }).count();
    expect(finalCount).toBe(120);
    expect(await page.locator(".wx-srv-day-separator").count()).toBeGreaterThan(1);

    expect(errors, `console errors: ${errors.join("; ")}`).toEqual([]);
  });

  test("the stream reconnects after a forced network drop", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = trackConsoleErrors(page);

    await unlockServer(page, "Josh");

    // Establish the stream is genuinely live before dropping it.
    await seed(page, { count: 1, label: "Reconnect-before" });
    await expect(page.locator(".wx-srv-bubble-text").filter({ hasText: "Reconnect-before #1" })).toBeVisible({
      timeout: 3000,
    });

    // A forced drop: cut the context's own network entirely (aborts the
    // in-flight stream fetch), hold it, then restore it — stream.ts's own
    // reconnect/backoff (spec/server-chat/00-brief.md §5.4/§10) must recover
    // without any page reload or user action.
    await context.setOffline(true);
    await page.waitForTimeout(1500);
    await context.setOffline(false);

    await seed(page, { count: 1, label: "Reconnect-after" });
    await expect(page.locator(".wx-srv-bubble-text").filter({ hasText: "Reconnect-after #1" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(".wx-srv-thread")).toBeVisible(); // never locked out by the drop itself

    expect(errors, `console errors: ${errors.join("; ")}`).toEqual([]);
    await context.close();
  });

  async function assertLayoutInvariants(page: Page, label: string): Promise<void> {
    const errors = trackConsoleErrors(page);
    await seed(page, { count: 40, label, spreadS: 30 });

    await unlockServer(page, "Tester");
    await expect(page.locator(".wx-srv-bubble-text").filter({ hasText: `${label} #40` })).toBeVisible();

    const mainScrollBefore = await page.locator(".wx-main").evaluate((el) => el.scrollTop);
    await page.locator(".wx-srv-thread").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const mainScrollAfter = await page.locator(".wx-main").evaluate((el) => el.scrollTop);
    expect(mainScrollAfter).toBe(mainScrollBefore); // .wx-main itself never scrolled

    const threadBox = await page.locator(".wx-srv-thread").boundingBox();
    const composerBox = await page.locator(".wx-srv-thread-view textarea").boundingBox();
    const viewport = page.viewportSize();
    expect(threadBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    if (threadBox !== null && composerBox !== null && viewport !== null) {
      // The composer is fully on-screen.
      expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(viewport.height + 1);
      expect(composerBox.y).toBeGreaterThanOrEqual(0);
    }

    // No horizontal overflow anywhere in the panel.
    const hasHorizontalOverflow = await page.locator(".wx-srv-panel").evaluate((el) => {
      return el.scrollWidth > el.clientWidth + 1;
    });
    expect(hasHorizontalOverflow).toBe(false);

    // The jump pill: scrolled away from the bottom, a new message reveals
    // it; clicking it returns to the bottom and hides it again.
    await page.locator(".wx-srv-thread").evaluate((el) => {
      el.scrollTop = 0;
    });
    await seed(page, { count: 1, label: `${label}-pill` });
    await expect(page.locator(".wx-srv-jump-pill")).toBeVisible({ timeout: 3000 });
    await page.locator(".wx-srv-jump-pill").click();
    await expect(page.locator(".wx-srv-jump-pill")).toBeHidden();

    expect(errors, `console errors: ${errors.join("; ")}`).toEqual([]);
  }

  test("layout invariants — desktop", async ({ browser }) => {
    const context: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await assertLayoutInvariants(page, "Desktop layout");
    await context.close();
  });

  test("layout invariants — mobile (390x844)", async ({ browser }) => {
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    const page = await context.newPage();
    await assertLayoutInvariants(page, "Mobile layout");
    await context.close();
  });

  test("a 12s-delayed delete stays removed for both users, then wipe and replay empty history", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const tag = `delete-wipe-${Date.now()}`;

    await unlockServer(pageA, "Josh");
    await unlockServer(pageB, "Purdy");
    await pageA.request.post("/test/server/seed-photo", {
      data: { sender: "Purdy", text: `${tag}: photo from Purdy` },
    });

    const photoBubbleA = pageA.locator(".wx-srv-bubble").filter({ hasText: `${tag}: photo from Purdy` });
    const photoBubbleB = pageB.locator(".wx-srv-bubble").filter({ hasText: `${tag}: photo from Purdy` });
    await waitVisible(photoBubbleA, pageA);
    await waitVisible(photoBubbleB, pageB);
    const oldMediaPath = await photoBubbleA.locator("img").getAttribute("src");
    expect(oldMediaPath).not.toBeNull();

    await pageA.request.post("/test/server/delete-response-delay", { data: { seconds: 12 } });
    const keepAliveTimer = setInterval(() => {
      void pageA.mouse.move(42, 42);
      void pageB.mouse.move(46, 46);
    }, 2_000);
    let deleteResponseReceived = false;
    const onResponse = (response: { url(): string; request(): { method(): string } }): void => {
      if (response.url().includes("/api/admin/server/messages/") && response.request().method() === "DELETE") {
        deleteResponseReceived = true;
      }
    };
    pageA.on("response", onResponse);
    try {
      // v1.5.2: these taps form a causal menu flow; test it at full speed so a
      // regression in the gesture-boundary markers trips R3 as it would for a user.
      await photoBubbleA.hover();
      await photoBubbleA.locator(".wx-srv-message-actions-trigger").click();
      await photoBubbleA.getByRole("menuitem", { name: "Delete for everyone" }).click();
      await expect(photoBubbleA.getByText("Delete this message for everyone?")).toBeVisible();
      const deleteResponse = pageA.waitForResponse((response) =>
        response.url().includes("/api/admin/server/messages/") && response.request().method() === "DELETE",
      );
      const deleteStartedAt = Date.now();
      await photoBubbleA.locator(".wx-srv-message-delete-confirm-button").click();
      await expect(photoBubbleA).toHaveCount(0);
      await expect(photoBubbleB).toHaveCount(0, { timeout: 3000 });
      expect(deleteResponseReceived).toBe(false);
      const response = await deleteResponse;
      expect(Date.now() - deleteStartedAt).toBeGreaterThanOrEqual(11_000);
      expect([204, 202]).toContain(response.status());
    } finally {
      clearInterval(keepAliveTimer);
      pageA.off("response", onResponse);
      await pageA.request.post("/test/server/delete-response-delay", { data: { seconds: 0 } });
    }

    if (oldMediaPath !== null) {
      const mediaUrl = new URL(oldMediaPath, pageA.url()).toString();
      const response = await contextA.request.get(mediaUrl);
      expect(response.status()).toBe(404);
    }

    const wipeLabel = `${tag}-remaining`;
    await seed(pageA, { count: 1, label: wipeLabel, sender: "Josh" });
    const remainingBubbleB = pageB.locator(".wx-srv-bubble").filter({ hasText: `${wipeLabel} #1` });
    await waitVisible(remainingBubbleB, pageB);

    await keepAlive(pageA);
    // Deleting and then opening settings are independent decisions, so retain
    // decision 00148's 400ms gap between these separate flows.
    await pageA.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
    await pageA.locator(".wx-srv-settings-button").click();
    await pageA.locator(".wx-srv-sheet-wipe").click();
    await expect(pageA.getByText(
      "Delete every message, photo, video and voice note for everyone? This can't be undone.",
    )).toBeVisible();
    await pageA.locator(".wx-srv-sheet-wipe-confirm-button").click();
    await expect(pageB.locator(".wx-srv-thread-empty")).toBeVisible({ timeout: 3000 });

    await pageB.reload();
    await unlockServer(pageB, "Purdy");
    await expect(pageB.locator(".wx-srv-thread-empty")).toBeVisible();

    await contextA.close();
    await contextB.close();
  });

  test("mobile long-press deletes for both users, wipe clears remaining history, and double-tap locks", async ({ browser }) => {
    const contextA = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const label = `mobile-message-actions-${Date.now()}`;
    await seed(pageA, { count: 2, label, sender: "Purdy" });
    await unlockServer(pageA, "Josh");
    await unlockServer(pageB, "Purdy");
    const deletedBubbleA = pageA.locator(".wx-srv-bubble").filter({ hasText: `${label} #1` });
    const deletedBubbleB = pageB.locator(".wx-srv-bubble").filter({ hasText: `${label} #1` });
    const lockBubble = pageA.locator(".wx-srv-bubble").filter({ hasText: `${label} #2` });
    await waitVisible(deletedBubbleA, pageA);
    await waitVisible(deletedBubbleB, pageB);
    await expect(lockBubble).toBeVisible();

    const pointer = { pointerType: "touch", pointerId: 1, clientX: 40, clientY: 40, button: 0 };
    await deletedBubbleA.dispatchEvent("pointerdown", pointer);
    await pageA.waitForTimeout(550);
    await expect(deletedBubbleA.locator(".wx-srv-message-actions")).toBeVisible();
    await expect(pageA.locator(".wx-srv-thread")).toBeVisible();
    await deletedBubbleA.dispatchEvent("pointerup", pointer);
    await deletedBubbleA.getByRole("menuitem", { name: "Delete for everyone" }).click();
    await deletedBubbleA.locator(".wx-srv-message-delete-confirm-button").click();
    await expect(deletedBubbleA).toHaveCount(0);
    await expect(deletedBubbleB).toHaveCount(0, { timeout: 3000 });
    await expect(pageA.locator(".wx-srv-thread")).toBeVisible();

    await pageA.waitForTimeout(MULTI_TAP_INTERVAL_MS + 50);
    await lockBubble.dispatchEvent("pointerdown", pointer);
    await lockBubble.dispatchEvent("pointerup", pointer);
    await pageA.waitForTimeout(80);
    await lockBubble.dispatchEvent("pointerdown", { ...pointer, pointerId: 2 });
    await expect(pageA.locator(".wx-srv-decoy")).toBeVisible();

    await unlockServer(pageA, "Josh");
    await keepAlive(pageB);
    const wipeLabel = `${label}-remaining`;
    await seed(pageA, { count: 1, label: wipeLabel, sender: "Josh" });
    const remainingBubbleB = pageB.locator(".wx-srv-bubble").filter({ hasText: `${wipeLabel} #1` });
    await waitVisible(remainingBubbleB, pageB);
    await keepAlive(pageA);
    await pageA.locator(".wx-srv-settings-button").click();
    await pageA.locator(".wx-srv-sheet-wipe").click();
    await pageA.locator(".wx-srv-sheet-wipe-confirm-button").click();
    await expect(pageB.locator(".wx-srv-thread-empty")).toBeVisible({ timeout: 3000 });

    await contextA.close();
    await contextB.close();
  });
});
