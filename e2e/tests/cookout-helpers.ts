// Shared helpers for the Cookout e2e specs: unlocking the Server chat, starting and joining a round and
// waiting for whose turn it is. Moved out of server-cookout.spec.ts unchanged (only `export` added) so the
// picture-first spec (server-cookout-visual.spec.ts) imports them instead of copying them.

import { expect } from "../fixtures";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Mirrors `MULTI_TAP_INTERVAL_MS` in admin-ui/src/server/constants.ts. */
export const MULTI_TAP_INTERVAL_MS = 400;

export async function unlockServer(page: Page, name: string): Promise<void> {
  const configResponse = await page.request.post("/test/server/config");
  const { pin } = (await configResponse.json()) as { pin: string };

  await page.goto("/admin/server");
  await expect(page.locator(".wx-srv-decoy")).toBeVisible();
  await page.locator(".wx-srv-panel").click();
  await expect(page.locator(".wx-srv-affordance")).toBeVisible();
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
  await page.locator(".wx-srv-affordance").click();
  await expect(page.locator(".wx-srv-pinpad")).toBeVisible();
  for (const digit of pin) {
    await page.locator(`.wx-srv-pinpad-key-digit:text-is("${digit}")`).click();
  }
  await page.locator(".wx-srv-pinpad-key-submit").click();

  await expect(page.locator(".wx-srv-name-prompt:visible, .wx-srv-thread:visible")).toBeVisible({ timeout: 5000 });
  if (await page.locator(".wx-srv-name-prompt").isVisible()) {
    await page.locator(".wx-srv-name-prompt-input").fill(name);
    await page.locator(".wx-srv-name-prompt-button").click();
  }
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
  await expect(page.locator(".wx-srv-name-prompt")).toBeHidden();
  // Two taps less than 400ms apart lock the chat (R3): let that window pass.
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

export async function humanPause(page: Page): Promise<void> {
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

/** A light touch so R7's 10s idle lock never fires on a page a test is only watching. A key press counts
 * as activity and, unlike a mouse move, cannot disturb a click another call is making on the same page. */
export async function keepAlive(page: Page): Promise<void> {
  try {
    await page.keyboard.press("Shift");
  } catch {
    // the page is closing
  }
}

/** Keeps every page awake for the whole of a test (stop it before closing the contexts). */
export function keepAwake(pages: readonly Page[]): () => void {
  const timer = setInterval(() => {
    for (const page of pages) void keepAlive(page);
  }, 2500);
  return () => clearInterval(timer);
}

export async function eventually(
  pages: readonly Page[],
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    for (const page of pages) await keepAlive(page);
    await pages[0]!.waitForTimeout(120);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

export async function closeAll(...contexts: BrowserContext[]): Promise<void> {
  for (const context of contexts) await context.close();
}

let shotDir: string | null = null;
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env["WIXY_E2E_SHOTS"];
  if (dir === undefined || dir === "") return;
  if (shotDir === null) {
    mkdirSync(dir, { recursive: true });
    shotDir = dir;
  }
  await page.screenshot({ path: join(shotDir, `${name}.png`) });
}

export function game(page: Page): Locator {
  return page.locator('.wx-srv-ck[data-game="cookout"]');
}

/** The two picture cards the active player may tap (a watcher's cards are plain divs, not buttons). */
export function pickable(page: Page): Locator {
  return game(page).locator(".wx-srv-ck-pair button.wx-srv-ck-card:not([disabled])");
}

/** The first time a browser opens a round being picked, the intro card covers the pane and blocks every tap
 * underneath: dismiss it with "Let's cook". */
export async function dismissIntro(page: Page): Promise<void> {
  const intro = game(page).locator(".wx-srv-ck-intro:not([hidden])");
  await expect(intro).toBeVisible();
  await humanPause(page);
  await intro.locator(".wx-srv-ck-intro-go").click();
  await expect(intro).toHaveCount(0);
  await humanPause(page);
}

/** Opens the basket sheet from the progress button (the old tray). */
export async function openBasket(page: Page): Promise<Locator> {
  await humanPause(page);
  await game(page).locator("button.wx-srv-ck-progress").click();
  const sheet = game(page).locator('.wx-srv-ck-sheet[data-sheet="basket"]');
  await expect(sheet).toBeVisible();
  return sheet;
}

export async function closeSheet(page: Page): Promise<void> {
  await humanPause(page);
  await game(page).locator(".wx-srv-ck-sheet-close").click();
  await expect(game(page).locator(".wx-srv-ck-sheet")).toBeHidden();
  await humanPause(page);
}

/** Opens the chat header's ... menu. A game tab runs full screen with the header hidden (decisions/00194),
 * so the menu is reached from the Chat tab, as a player would. */
export async function openMoreMenu(page: Page): Promise<void> {
  const chatTab = page.locator(".wx-srv-tab-chat");
  if (await chatTab.isVisible()) {
    await chatTab.click();
    await humanPause(page);
  }
  await page.locator(".wx-srv-more-button").click();
}

/** Starts a Cookout from the ... menu and its start sheet; the starter lands in the Cookout tab and the intro
 * card is dismissed (unless `intro` is false). */
export async function startCookout(page: Page, blind: boolean, intro = true): Promise<string> {
  const before = await page.locator(".wx-srv-bubble-ck").count();
  await openMoreMenu(page);
  await expect(page.locator(".wx-srv-more-cookout")).toBeVisible();
  await humanPause(page);
  await page.locator(".wx-srv-more-cookout").click();
  const mode = page.getByRole("radio", { name: blind ? /Blind mode/ : /Open mode/ });
  await expect(mode).toBeVisible();
  await mode.click();
  await humanPause(page);
  await page.locator(".wx-srv-ck-start-go").click();
  await expect(page.locator(".wx-srv-bubble-ck")).toHaveCount(before + 1);
  await expect(game(page)).toBeVisible();
  const seq = await page.locator(".wx-srv-bubble-ck").last().getAttribute("data-message-seq");
  expect(seq).not.toBeNull();
  if (intro) await dismissIntro(page);
  return seq!;
}

/** The partner opens the round's card in the chat, dismisses the intro and presses Join (in the turn banner). */
export async function joinCookout(page: Page, seq: string): Promise<void> {
  const card = page.locator(`.wx-srv-bubble-ck[data-message-seq="${seq}"]`);
  await eventually([page], async () => await card.isVisible(), "the partner sees the Cookout card");
  await card.locator(".wx-srv-ck-mcard-open").click();
  await expect(game(page)).toBeVisible();
  await dismissIntro(page);
  const join = game(page).locator(".wx-srv-ck-banner .wx-srv-ck-join");
  await expect(join).toBeVisible();
  await humanPause(page);
  await join.click();
  await expect(join).toHaveCount(0);
}

/** Waits until exactly one of the pages has a pair it may pick from; returns that page and its index. */
export async function whoseTurn(pages: readonly Page[]): Promise<{ page: Page; index: number }> {
  let found = -1;
  await eventually(
    pages,
    async () => {
      const counts = await Promise.all(pages.map(async (p) => await pickable(p).count()));
      const active = counts.flatMap((c, i) => (c === 2 ? [i] : []));
      if (active.length !== 1) return false;
      found = active[0]!;
      return true;
    },
    "someone's turn to pick",
    30_000,
  );
  return { page: pages[found]!, index: found };
}

export interface TwistChoices {
  readonly style?: "spin";
  readonly challenge?: "one-pan";
  readonly cloche?: boolean;
  readonly stars?: boolean;
  readonly fridge?: string;
}

/** Like `startCookout`, but turns the named start-sheet twists on first (the ones `server-cookout-twists.spec.ts`
 * drives), so a spec can play a round with every twist on. Returns the round's seq. */
export async function startCookoutWithTwists(page: Page, blind: boolean, twists: TwistChoices): Promise<string> {
  const before = await page.locator(".wx-srv-bubble-ck").count();
  await openMoreMenu(page);
  await expect(page.locator(".wx-srv-more-cookout")).toBeVisible();
  await humanPause(page);
  await page.locator(".wx-srv-more-cookout").click();
  await humanPause(page);
  await page.getByRole("radio", { name: blind ? /Blind mode/ : /Open mode/ }).click();
  await humanPause(page);
  await page.locator(".wx-srv-ck-twists-toggle").click();
  await expect(page.locator(".wx-srv-ck-twists-body")).toBeVisible();
  await humanPause(page);
  if (twists.style !== undefined) {
    await page.locator(`.wx-srv-ck-twist-chip[data-style="${twists.style}"]`).click();
    await humanPause(page);
  }
  if (twists.challenge !== undefined) {
    await page.locator(`.wx-srv-ck-twist-chip[data-challenge="${twists.challenge}"]`).click();
    await humanPause(page);
  }
  if (twists.cloche === true) {
    await page.locator(".wx-srv-ck-twist-cloche").click();
    await humanPause(page);
  }
  if (twists.stars === true) {
    await page.locator(".wx-srv-ck-twist-stars").click();
    await humanPause(page);
  }
  if (twists.fridge !== undefined) {
    await page.locator(".wx-srv-ck-fridge-input").fill(twists.fridge);
    const option = page.locator(".wx-srv-ck-fridge-option").first();
    await expect(option).toBeVisible();
    await humanPause(page);
    await option.click();
    await expect(page.locator(".wx-srv-ck-fridge-chip")).toBeVisible();
  }
  await humanPause(page);
  await page.locator(".wx-srv-ck-start-go").click();
  await expect(page.locator(".wx-srv-bubble-ck")).toHaveCount(before + 1);
  await expect(game(page)).toBeVisible();
  const seq = await page.locator(".wx-srv-bubble-ck").last().getAttribute("data-message-seq");
  expect(seq).not.toBeNull();
  await dismissIntro(page);
  return seq!;
}
