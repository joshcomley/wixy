// E2E for FULL-SCREEN GAME MODE (decisions/00194): a game tab hides the chat header and the composer; the
// Chat tab brings both back; a call that is not idle keeps the header (the call controls live in it — an
// incoming call's Answer must never be hidden, Inv 55); the two lock affordances left (R3 multi-tap, Escape)
// still work. Would you rather is the game used: it needs no globe.

import { expect, test } from "../fixtures";
import type { Page } from "@playwright/test";
import { trackConsoleErrors } from "./helpers";

test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } });
test.describe.configure({ timeout: 120_000 });

const MULTI_TAP_INTERVAL_MS = 400;

async function unlock(page: Page, name: string): Promise<void> {
  const { pin } = (await (await page.request.post("/test/server/config")).json()) as { pin: string };
  await page.goto("/admin/server");
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  await page.locator(".wx-srv-panel").click();
  await expect(page.locator(".wx-srv-affordance")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
  await page.locator(".wx-srv-affordance").click();
  for (const digit of pin) await page.locator(`.wx-srv-pinpad-key-digit:text-is("${digit}")`).click();
  await page.locator(".wx-srv-pinpad-key-submit").click();
  await expect(page.locator(".wx-srv-name-prompt:visible, .wx-srv-thread:visible")).toBeVisible({ timeout: 5000 });
  if (await page.locator(".wx-srv-name-prompt").isVisible()) {
    await page.locator(".wx-srv-name-prompt-input").fill(name);
    await page.locator(".wx-srv-name-prompt-button").click();
  }
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

async function startWyr(page: Page): Promise<void> {
  await page.locator(".wx-srv-more-button").click();
  await expect(page.locator(".wx-srv-more-wyr")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
  await page.locator(".wx-srv-more-wyr").click();
  await expect(page.locator(".wx-srv-game")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

const PHONE = { viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true } as const;

test("a game tab hides the header and composer; Chat brings them back; a ringing call keeps the header", async ({ browser }) => {
  const a = await browser.newContext({ ...PHONE, permissions: ["microphone"] });
  const b = await browser.newContext({ ...PHONE, permissions: ["microphone"] });
  const pa = await a.newPage();
  const pb = await b.newPage();
  const errors = [trackConsoleErrors(pa), trackConsoleErrors(pb)];
  try {
    await unlock(pa, "Caller");
    await unlock(pb, "Receiver");
    await startWyr(pb);

    // Receiver is in the game tab: full screen.
    await expect(pb.locator(".wx-srv-thread-header")).toBeHidden();
    await expect(pb.locator(".wx-srv-thread-view > .wx-chat-composer")).toBeHidden();
    const pane = (await pb.locator(".wx-srv-game").boundingBox())!;
    const view = (await pb.locator(".wx-srv-thread-view").boundingBox())!;
    expect(pane.y - view.y).toBeLessThanOrEqual(12); // from the very top of the chat view

    // The Chat tab restores both, exactly as before.
    await pb.locator(".wx-srv-tab-chat").click();
    await expect(pb.locator(".wx-srv-thread-header")).toBeVisible();
    await expect(pb.locator(".wx-srv-thread-view > .wx-chat-composer")).toBeVisible();
    await pb.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
    await pb.locator(".wx-srv-tab-wyr").click();
    await expect(pb.locator(".wx-srv-thread-header")).toBeHidden();

    // Caller rings Receiver: the header (with Answer) shows up in the game tab at once.
    await pa.locator(".wx-srv-call").getByRole("button", { name: "Call", exact: true }).click();
    await pa.getByRole("radio", { name: /Receiver/ }).check();
    await pa.getByRole("button", { name: "Confirm call", exact: true }).click();
    await expect(pb.locator(".wx-srv-call")).toContainText("Incoming call");
    await expect(pb.locator(".wx-srv-thread-header")).toBeVisible();
    await expect(pb.locator(".wx-srv-call").getByRole("button", { name: "Answer", exact: true })).toBeVisible();
    await expect(pb.locator(".wx-srv-call").getByRole("button", { name: "Decline", exact: true })).toBeVisible();
    const answer = (await pb.locator(".wx-srv-call").getByRole("button", { name: "Answer", exact: true }).boundingBox())!;
    expect(answer.x + answer.width).toBeLessThanOrEqual(360.5);
    expect(answer.y).toBeGreaterThanOrEqual(0);
    // Still in the game tab underneath, and nothing hides the Answer button.
    await expect(pb.locator(".wx-srv-tab-wyr")).toHaveClass(/wx-srv-tab-on/);
    await pb.screenshot({ path: test.info().outputPath("phone-ringing-in-game.png") });
    const shots = process.env["WIXY_E2E_SHOTS"];
    if (shots !== undefined && shots !== "") await pb.screenshot({ path: `${shots}/08-ringing-call-in-game-mode.png` });

    // Declined: the call is idle again and the header goes back to being hidden.
    await pb.locator(".wx-srv-call").getByRole("button", { name: "Decline", exact: true }).click();
    await expect(pb.locator(".wx-srv-thread-header")).toBeHidden({ timeout: 10_000 });
    expect(errors.flatMap((e) => e.filter((m) => !/favicon|NotAllowed|getUserMedia/i.test(m)))).toEqual([]);
  } finally {
    await a.close();
    await b.close();
  }
});

test("in game mode the multi-tap lock (on a non-globe area) and Escape still lock the chat", async ({ browser }) => {
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  try {
    await unlock(page, "Alice");
    await startWyr(page);
    await expect(page.locator(".wx-srv-thread-header")).toBeHidden(); // the ✕ is gone: only these remain

    // R3: a double-tap in the same place on the pane's background locks (the title text is not a control).
    const title = page.locator(".wx-srv-game-title");
    await title.click();
    await title.click();
    await expect(page.locator(".wx-srv-thread")).toHaveCount(0);

    // Escape locks too (the panic key).
    await unlock(page, "Alice");
    await page.locator(".wx-srv-tab-wyr").click();
    await expect(page.locator(".wx-srv-game")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".wx-srv-thread")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// The tab bar is DOCKED: edge to edge and flush with the bottom of the screen, in the Chat tab and a game
// tab, on phones and desktop (the safe-area inset is padding INSIDE the bar, never a gap under it).
for (const vp of [
  { name: "360x740", viewport: { width: 360, height: 740 }, mobile: true },
  { name: "390x844", viewport: { width: 390, height: 844 }, mobile: true },
  { name: "1280x800", viewport: { width: 1280, height: 800 }, mobile: false },
]) {
  test(`the tab bar is docked to the screen edges (${vp.name})`, async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: vp.viewport,
      hasTouch: vp.mobile,
      isMobile: vp.mobile,
      permissions: ["microphone"],
    });
    const page = await ctx.newPage();
    try {
      await unlock(page, "Docker");
      await startWyr(page);
      const shot = process.env["DOCK_SHOTS"];
      for (const tab of [".wx-srv-tab-wyr", ".wx-srv-tab-chat"]) {
        await page.locator(tab).click();
        await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
        if (shot) await page.screenshot({ path: `${shot}/${vp.name}-${tab.slice(12)}.png` });
        const bar = (await page.locator(".wx-srv-tabs").boundingBox())!;
        expect(Math.abs(bar.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(bar.x + bar.width - vp.viewport.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(bar.y + bar.height - vp.viewport.height)).toBeLessThanOrEqual(1);
      }
    } finally {
      await ctx.close();
    }
  });
}
