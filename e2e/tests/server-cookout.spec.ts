// E2E for Cookout, the two-player ingredient-picking game (workspace 00058, spec/server-chat/09-cookout.md):
// two people (two browser contexts) play a whole round with real clicks. Open mode: both see every pair,
// the starter uses both skips (the third pair's Skip is the disabled "Final pair"), the partner joins explicitly, ten
// picks alternate, the chef's three dishes appear (the fake cmd answers the hidden concepts run with the
// canned dishes built from the basket), "Bank this" turns a dish into a saved full recipe, and the Recipe
// book lists it. Blind mode: the partner's pair and picks are never in the other browser's DOM nor in any
// response it received until the ten are done, then both see the reveal; an ended Blind game never
// reveals. Cookout and the other games replace each other in the tab bar (only ever two tabs), the card
// has the shared mini chat, and the pane fits a 360 px phone.
//
// The fixture server has no ComfyUI, so the dishes have no pictures (that path is covered by the unit
// tests), so every picture is the emoji tile; everything else is the real server, store, runner and client.
// The picture-first table (spec/server-chat/09b): a first-time INTRO card blocks the pane until "Let's cook",
// one tap on a picture card picks, the basket is the progress button and its sheet. Set WIXY_E2E_SHOTS=<dir> to also
// save screenshots of the main flow's key moments.

import { expect, test } from "../fixtures";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { trackConsoleErrors } from "./helpers";

test.describe.configure({ timeout: 240_000 });

/** Mirrors `MULTI_TAP_INTERVAL_MS` in admin-ui/src/server/constants.ts. */
const MULTI_TAP_INTERVAL_MS = 400;

async function unlockServer(page: Page, name: string): Promise<void> {
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

async function humanPause(page: Page): Promise<void> {
  await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100);
}

/** A light touch so R7's 10s idle lock never fires on a page a test is only watching. A key press counts
 * as activity and, unlike a mouse move, cannot disturb a click another call is making on the same page. */
async function keepAlive(page: Page): Promise<void> {
  try {
    await page.keyboard.press("Shift");
  } catch {
    // the page is closing
  }
}

/** Keeps every page awake for the whole of a test (stop it before closing the contexts). */
function keepAwake(pages: readonly Page[]): () => void {
  const timer = setInterval(() => {
    for (const page of pages) void keepAlive(page);
  }, 2500);
  return () => clearInterval(timer);
}

async function eventually(
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

async function closeAll(...contexts: BrowserContext[]): Promise<void> {
  for (const context of contexts) await context.close();
}

let shotDir: string | null = null;
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env["WIXY_E2E_SHOTS"];
  if (dir === undefined || dir === "") return;
  if (shotDir === null) {
    mkdirSync(dir, { recursive: true });
    shotDir = dir;
  }
  await page.screenshot({ path: join(shotDir, `${name}.png`) });
}

function game(page: Page): Locator {
  return page.locator('.wx-srv-ck[data-game="cookout"]');
}

/** The two picture cards the active player may tap (a watcher's cards are plain divs, not buttons). */
function pickable(page: Page): Locator {
  return game(page).locator(".wx-srv-ck-pair button.wx-srv-ck-card:not([disabled])");
}

/** The first time a browser opens a round being picked, the intro card covers the pane and blocks every tap
 * underneath: dismiss it with "Let's cook". */
async function dismissIntro(page: Page): Promise<void> {
  const intro = game(page).locator(".wx-srv-ck-intro:not([hidden])");
  await expect(intro).toBeVisible();
  await humanPause(page);
  await intro.locator(".wx-srv-ck-intro-go").click();
  await expect(intro).toHaveCount(0);
  await humanPause(page);
}

/** Opens the basket sheet from the progress button (the old tray). */
async function openBasket(page: Page): Promise<Locator> {
  await humanPause(page);
  await game(page).locator("button.wx-srv-ck-progress").click();
  const sheet = game(page).locator('.wx-srv-ck-sheet[data-sheet="basket"]');
  await expect(sheet).toBeVisible();
  return sheet;
}

async function closeSheet(page: Page): Promise<void> {
  await humanPause(page);
  await game(page).locator(".wx-srv-ck-sheet-close").click();
  await expect(game(page).locator(".wx-srv-ck-sheet")).toBeHidden();
  await humanPause(page);
}

/** Opens the chat header's ... menu. A game tab runs full screen with the header hidden (decisions/00194),
 * so the menu is reached from the Chat tab, as a player would. */
async function openMoreMenu(page: Page): Promise<void> {
  const chatTab = page.locator(".wx-srv-tab-chat");
  if (await chatTab.isVisible()) {
    await chatTab.click();
    await humanPause(page);
  }
  await page.locator(".wx-srv-more-button").click();
}

/** Starts a Cookout from the ... menu and its start sheet; the starter lands in the Cookout tab and the intro
 * card is dismissed (unless `intro` is false). */
async function startCookout(page: Page, blind: boolean, intro = true): Promise<string> {
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
async function joinCookout(page: Page, seq: string): Promise<void> {
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
async function whoseTurn(pages: readonly Page[]): Promise<{ page: Page; index: number }> {
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

interface Offer {
  readonly ids: string[];
  readonly names: string[];
}

async function offerOn(page: Page): Promise<Offer> {
  const cards = game(page).locator(".wx-srv-ck-pair .wx-srv-ck-card");
  await expect(cards).toHaveCount(2);
  const ids = await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-ingredient") ?? ""));
  const names = await cards.evaluateAll((els) => els.map((e) => e.querySelector(".wx-srv-ck-card-name")?.textContent ?? ""));
  return { ids, names };
}

/** The active player picks the first card of the pair; returns what was on offer and what was picked. */
async function pickFirst(page: Page): Promise<{ offer: Offer; picked: string; pickedName: string }> {
  const offer = await offerOn(page);
  const picked = offer.ids[0]!;
  await humanPause(page);
  await pickable(page).first().click();
  await expect(game(page).locator(`.wx-srv-ck-table-stage [data-ingredient="${picked}"]`)).toHaveCount(0, { timeout: 15_000 });
  return { offer, picked, pickedName: offer.names[0]! };
}

/** Collects the body of every Cookout response a page received, to prove what the server withheld. */
function recordBodies(page: Page): string[] {
  const bodies: string[] = [];
  page.on("response", (response) => {
    if (!response.url().includes("/server/cookout/") || response.request().method() === "OPTIONS") return;
    void response.text().then(
      (text) => bodies.push(text),
      () => undefined,
    );
  });
  return bodies;
}

/** The cupboard staples are listed in every view, so they are never "withheld". */
const STAPLE_IDS = new Set(["water", "salt", "black-pepper", "butter", "plain-flour", "cooking-oil", "granulated-sugar", "milk"]);

/** True when any response body carries this exact ingredient id as a JSON string value. */
function bodyHasId(bodies: readonly string[], id: string): boolean {
  const parsed = bodies.flatMap((body) => {
    try {
      return [JSON.parse(body) as unknown];
    } catch {
      return [];
    }
  });
  const found = (value: unknown): boolean => {
    if (value === id) return true;
    if (Array.isArray(value)) return value.some(found);
    if (value !== null && typeof value === "object") return Object.values(value).some(found);
    return false;
  };
  return parsed.some(found);
}

/** True when the screen text shows this ingredient name as whole words. */
function textShows(text: string, name: string): boolean {
  const lower = text.toLowerCase();
  const needle = name.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? " " : lower.charAt(at - 1);
    const after = lower.charAt(at + needle.length) || " ";
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = at + 1;
  }
}

async function dishCount(page: Page): Promise<number> {
  return await game(page).locator(".wx-srv-ck-dish").count();
}

test.describe("Cookout", () => {
  test("Open mode: join, skips, ten picks, three dishes, Bank this and the Recipe book", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errors = [trackConsoleErrors(pageA), trackConsoleErrors(pageB)];
    await unlockServer(pageA, "Alice");
    await unlockServer(pageB, "Bob");
    const stopAwake = keepAwake([pageA, pageB]);

    const seq = await startCookout(pageA, false);
    await expect(game(pageA).locator(".wx-srv-ck-badge")).toHaveText("Open");
    // Alice's first pair is dealt at once; Bob has not joined, so nobody can pick for slot 2 yet.
    await expect(pickable(pageA)).toHaveCount(2);
    await shot(pageA, "cookout-1-first-pair");

    await joinCookout(pageB, seq);
    await shot(pageB, "cookout-2-bob-joined");

    // Turn 1: Alice skips twice (both are open, so Bob watches the same pairs), then the third pair's Skip is
    // the disabled "Final pair" and must be picked from.
    const firstPair = await offerOn(pageA);
    await eventually([pageA, pageB], async () => (await game(pageB).locator(".wx-srv-ck-pair .wx-srv-ck-card").count()) === 2, "Bob watches the pair");
    expect(await offerOn(pageB)).toEqual(firstPair);
    await expect(game(pageB).locator("button.wx-srv-ck-card")).toHaveCount(0); // watching, not picking
    const skip = game(pageA).locator(".wx-srv-ck-skip");
    await expect(skip).toHaveText("Deal two new ones (2 left)");
    for (const [offer, label] of [
      ["1", "Deal two new ones (1 left)"],
      ["2", "Final pair"],
    ] as const) {
      await humanPause(pageA);
      await skip.click();
      await expect(game(pageA).locator(".wx-srv-ck-pair")).toHaveAttribute("data-offer", offer);
      await expect(skip).toHaveText(label);
      await eventually([pageA, pageB], async () => (await game(pageB).locator(".wx-srv-ck-pair").getAttribute("data-offer")) === offer, `Bob sees pair ${offer}`);
    }
    await expect(skip).toBeDisabled();
    await expect(skip).toHaveClass(/wx-srv-ck-skip-final/);
    await expect(game(pageA).locator(".wx-srv-ck-turn-sub")).toContainText("final pair");
    await shot(pageA, "cookout-3-forced-pick");

    // Ten picks, strictly alternating, starting with Alice.
    const picked: string[] = [];
    const order: number[] = [];
    for (let turn = 1; turn <= 10; turn += 1) {
      const { page, index } = await whoseTurn([pageA, pageB]);
      order.push(index);
      const result = await pickFirst(page);
      picked.push(result.pickedName);
    }
    expect(order).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);

    // The chef's three dishes appear for both.
    await eventually([pageA, pageB], async () => (await dishCount(pageA)) === 3 && (await dishCount(pageB)) === 3, "the three dishes", 60_000);
    await expect(game(pageA).locator(".wx-srv-ck-reveal .wx-srv-ck-rtile")).toHaveCount(10);
    for (const name of picked) await expect(game(pageB).locator(".wx-srv-ck-reveal")).toContainText(name);
    await shot(pageA, "cookout-4-three-dishes");

    // Bank this: Alice banks the first dish; "Writing recipe..." then "Banked" on both screens.
    const title = (await game(pageA).locator(".wx-srv-ck-dish-title").first().innerText()).trim();
    await humanPause(pageA);
    await game(pageA).locator(".wx-srv-ck-dish").first().locator(".wx-srv-ck-bank").click();
    const bankedA = game(pageA).locator(".wx-srv-ck-dish").first().locator(".wx-srv-ck-banked");
    const bankedB = game(pageB).locator(".wx-srv-ck-dish").first().locator(".wx-srv-ck-banked");
    await expect(bankedA).toContainText("Banked", { timeout: 60_000 });
    await expect(bankedB).toContainText("Banked", { timeout: 20_000 });
    await expect(game(pageA).locator(".wx-srv-ck-dish").nth(1).locator(".wx-srv-ck-bank")).toBeVisible(); // the others are still offered

    await humanPause(pageB);
    await bankedB.click();
    const recipe = game(pageB).locator(".wx-srv-ck-recipe");
    await expect(recipe).toBeVisible();
    expect(await recipe.locator(".wx-srv-ck-recipe-ing").count()).toBeGreaterThan(0);
    expect(await recipe.locator(".wx-srv-ck-recipe-step").count()).toBeGreaterThan(0);
    await expect(recipe).toContainText("Banked by Alice");
    await shot(pageB, "cookout-5-full-recipe");

    // The Recipe book (the pane's own title-row button: the chat header is hidden in a game) lists it.
    await game(pageB).locator(".wx-srv-ck-book").click();
    await humanPause(pageB);
    const entries = pageB.locator(".wx-srv-ck-book-entry");
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toContainText(title);
    await shot(pageB, "cookout-6-recipe-book");
    await humanPause(pageB);
    await pageB.locator(".wx-srv-ck-book-close").click();
    await expect(pageB.locator(".wx-srv-ck-book-view")).toBeHidden();

    // It survives a reload: the finished round, its dishes and the banked recipe are stored.
    await pageA.reload();
    await unlockServer(pageA, "Alice");
    await pageA.locator(`.wx-srv-bubble-ck[data-message-seq="${seq}"] .wx-srv-ck-mcard-open`).click();
    await eventually([pageA], async () => (await dishCount(pageA)) === 3, "the dishes after a reload");
    await expect(game(pageA).locator(".wx-srv-ck-dish").first().locator(".wx-srv-ck-banked")).toContainText("Banked");

    stopAwake();
    for (const e of errors) expect(e.filter((m) => !/favicon/i.test(m))).toEqual([]);
    await closeAll(contextA, contextB);
  });

  test("Blind mode: the partner's pair and picks never reach the other browser until all ten are done", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errors = [trackConsoleErrors(pageA), trackConsoleErrors(pageB)];
    await unlockServer(pageA, "Alice");
    await unlockServer(pageB, "Bob");
    const bodiesA = recordBodies(pageA);
    const bodiesB = recordBodies(pageB);
    const stopAwake = keepAwake([pageA, pageB]);

    const seq = await startCookout(pageA, true);
    await expect(game(pageA).locator(".wx-srv-ck-badge")).toHaveText("Blind");
    await joinCookout(pageB, seq);

    const pages = [pageA, pageB] as const;
    const offeredTo: [Offer[], Offer[]] = [[], []];
    const picked: string[] = [];
    for (let turn = 1; turn <= 10; turn += 1) {
      const { page, index } = await whoseTurn(pages);
      const other = pages[1 - index]!;
      const offer = await offerOn(page);
      offeredTo[index]!.push(offer);

      // The waiting player sees a secret turn and no ingredient at all: not in the DOM...
      await eventually(pages, async () => (await game(other).locator(".wx-srv-ck-cloche").count()) === 1, "the other side shows a secret turn");
      await expect(game(other).locator("[data-ingredient]")).toHaveCount(0);
      // The whole scrolling pane (banner, progress and stage) plus the chat card for this round.
      const text =
        (await game(other).locator(".wx-srv-ck-scroll").innerText()) + " " + (await other.locator(`.wx-srv-bubble-ck[data-message-seq="${seq}"]`).innerText());
      offer.ids.forEach((id, i) => {
        if (!STAPLE_IDS.has(id)) expect(textShows(text, offer.names[i]!), `${offer.names[i]} is on the waiting screen`).toBe(false);
      });
      await expect(game(other)).toContainText("Secret turn");
      if (turn === 3) {
        // The basket sheet (the old tray) on the waiting screen: the partner's picks are locks, never names.
        const basket = await openBasket(other);
        await expect(basket.locator(".wx-srv-ck-bline-secret")).not.toHaveCount(0);
        const basketText = await basket.innerText();
        for (const seen of offeredTo[index]!) {
          seen.ids.forEach((id, i) => {
            if (!STAPLE_IDS.has(id)) expect(textShows(basketText, seen.names[i]!), `${seen.names[i]} is in the waiting basket sheet`).toBe(false);
          });
        }
        await closeSheet(other);
      }

      if (turn === 1) await shot(pageB, "cookout-blind-secret-turn");
      const result = await pickFirst(page);
      picked.push(result.pickedName);
      // ...and the picker's own earlier picks show to them, the partner's as locks (the progress button's lock tiles).
      if (turn >= 2) await expect(game(other).locator(".wx-srv-ck-prog-secret")).not.toHaveCount(0);
      if (turn === 9) {
        // Nine picks in, the last turn is the only one left: still nothing of the partner's, anywhere.
        const aSaw = offeredTo[0].flatMap((o) => o.ids);
        const bSaw = offeredTo[1].flatMap((o) => o.ids);
        for (const id of aSaw.filter((i) => !STAPLE_IDS.has(i))) expect(bodyHasId(bodiesB, id), `Bob's responses carry ${id}`).toBe(false);
        for (const id of bSaw.filter((i) => !STAPLE_IDS.has(i))) expect(bodyHasId(bodiesA, id), `Alice's responses carry ${id}`).toBe(false);
      }
    }

    // All ten are in: both screens reveal the whole basket and the chef's dishes.
    await eventually(pages, async () => (await dishCount(pageA)) === 3 && (await dishCount(pageB)) === 3, "the three dishes", 60_000);
    for (const page of pages) {
      await expect(game(page).locator(".wx-srv-ck-reveal .wx-srv-ck-rtile")).toHaveCount(10);
      await expect(game(page).locator(".wx-srv-ck-reveal-title")).toContainText("big reveal");
      for (const name of picked) await expect(game(page).locator(".wx-srv-ck-reveal")).toContainText(name);
    }
    await shot(pageB, "cookout-blind-reveal");

    stopAwake();
    for (const e of errors) expect(e.filter((m) => !/favicon/i.test(m))).toEqual([]);
    await closeAll(contextA, contextB);
  });

  test("End game: a Blind round that is ended never reveals the picks, and the partner sees it ended", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await unlockServer(pageA, "Alice");
    await unlockServer(pageB, "Bob");
    const bodiesB = recordBodies(pageB);
    const stopAwake = keepAwake([pageA, pageB]);

    const seq = await startCookout(pageA, true);
    await joinCookout(pageB, seq);
    const pages = [pageA, pageB] as const;
    const aOffers: string[] = [];
    for (let turn = 1; turn <= 3; turn += 1) {
      const { page, index } = await whoseTurn(pages);
      if (index === 0) aOffers.push(...(await offerOn(page)).ids);
      await pickFirst(page);
    }

    // Alice ends the game: a confirmation first, "Keep playing" changes nothing, "End game" ends it.
    await humanPause(pageA);
    await game(pageA).locator(".wx-srv-ck-end").click();
    await expect(game(pageA).locator(".wx-srv-ck-confirm")).toBeVisible();
    await game(pageA).locator(".wx-srv-ck-confirm-keep").click();
    await expect(game(pageA).locator(".wx-srv-ck-confirm")).toBeHidden();
    await humanPause(pageA);
    await game(pageA).locator(".wx-srv-ck-end").click();
    await game(pageA).locator(".wx-srv-ck-confirm-end").click();
    await expect(game(pageA).locator(".wx-srv-ck-ended")).toBeVisible();
    await eventually([...pages], async () => (await game(pageB).locator(".wx-srv-ck-ended").count()) === 1, "Bob sees it ended");

    // Nothing was revealed to Bob: no reveal banner, no ingredient of Alice's, in the DOM or any response.
    await expect(game(pageB).locator(".wx-srv-ck-reveal")).toHaveCount(0);
    // No ingredient at all is left in Bob's DOM (not even hidden), and none of Alice's offered ones anywhere.
    await expect(game(pageB).locator("[data-ingredient]")).toHaveCount(0);
    for (const id of aOffers.filter((i) => !STAPLE_IDS.has(i))) await expect(game(pageB).locator(`[data-ingredient="${id}"]`), `Alice's ${id} is in Bob's DOM`).toHaveCount(0);
    for (const id of aOffers.filter((i) => !STAPLE_IDS.has(i))) expect(bodyHasId(bodiesB, id), `Bob's responses carry ${id}`).toBe(false);
    // An ended round cannot be played on: neither side has a pair to pick from.
    await expect(pickable(pageA)).toHaveCount(0);
    await expect(pickable(pageB)).toHaveCount(0);

    stopAwake();
    await closeAll(contextA, contextB);
  });

  test("Cookout replaces an open Adventure or Would-you-rather tab (only ever two tabs); the round has the shared chat FAB, floating message and quick reply", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errors = [trackConsoleErrors(pageA), trackConsoleErrors(pageB)];
    await unlockServer(pageA, "Alice");
    await unlockServer(pageB, "Bob");
    const stopAwake = keepAwake([pageA, pageB]);

    // An Adventure is open: its tab is the one game tab.
    await openMoreMenu(pageA);
    await expect(pageA.locator(".wx-srv-more-adventure")).toBeVisible();
    await humanPause(pageA);
    await pageA.locator(".wx-srv-more-adventure").click();
    await expect(pageA.locator(".wx-srv-tab-adventure")).toBeVisible();
    await expect(pageA.locator(".wx-srv-tab-game:visible")).toHaveCount(1);

    // Starting a Cookout takes its place.
    const seq = await startCookout(pageA, false);
    await expect(pageA.locator(".wx-srv-tab-cookout")).toBeVisible();
    await expect(pageA.locator(".wx-srv-tab-adventure")).toBeHidden();
    await expect(pageA.locator(".wx-srv-tab-game:visible")).toHaveCount(1);

    // Starting Would-you-rather takes the Cookout tab's place; the card is still in the chat.
    await openMoreMenu(pageA);
    await humanPause(pageA);
    await pageA.locator(".wx-srv-more-wyr").click();
    await expect(pageA.locator(".wx-srv-tab-wyr")).toBeVisible();
    await expect(pageA.locator(".wx-srv-tab-cookout")).toBeHidden();
    await expect(pageA.locator(".wx-srv-tab-game:visible")).toHaveCount(1);
    await expect(pageA.locator(`.wx-srv-bubble-ck[data-message-seq="${seq}"]`)).toBeAttached();

    // Bob opens the (still picking) Cookout from its card; it replaces whatever he had.
    await joinCookout(pageB, seq);
    await expect(pageB.locator(".wx-srv-tab-cookout")).toBeVisible();
    await expect(pageB.locator(".wx-srv-tab-game:visible")).toHaveCount(1);

    // The round's chat (decisions/00194): the game runs full screen (no chat header, no composer at home);
    // Alice writes in the chat FAB's pop-up, Bob sees it FLOAT (the FAB gets a dot) and answers in the quick
    // reply, which sends into the round and closes; the pop-up holds the round's whole chat.
    await pageA.locator(".wx-srv-tab-chat").click();
    await humanPause(pageA);
    await pageA.locator(`.wx-srv-bubble-ck[data-message-seq="${seq}"] .wx-srv-ck-mcard-open`).click();
    await expect(game(pageA)).toBeVisible();
    await expect(pageA.locator(".wx-srv-thread-view > .wx-chat-composer")).toBeHidden();
    async function say(page: Page, text: string): Promise<void> {
      await page.locator(".wx-chat-composer-input").fill(text);
      await page.locator(".wx-chat-send-button").click();
      await humanPause(page);
    }
    await game(pageA).locator(".wx-srv-float-fab").click();
    await expect(pageA.locator(".wx-srv-gamepop .wx-chat-composer-input")).toBeVisible();
    await say(pageA, "salt or butter?");
    await pageA.locator(".wx-srv-gamepop-close").click();
    await expect(pageA.locator(".wx-srv-gamepop")).toBeHidden();
    await expect(game(pageB).locator(".wx-srv-float-bubble")).toContainText("salt or butter?", { timeout: 20_000 });
    await expect(game(pageB).locator(".wx-srv-float-bubble")).toContainText("Alice:");
    await expect(game(pageB).locator(".wx-srv-float-fab")).toHaveAttribute("aria-label", /new message/);
    await humanPause(pageB);
    await game(pageB).locator(".wx-srv-float-open").click();
    await expect(pageB.locator(".wx-srv-quick .wx-chat-composer-input")).toBeVisible();
    await say(pageB, "butter, always");
    await expect(pageB.locator(".wx-srv-quick")).toBeHidden();
    await expect(game(pageA).locator(".wx-srv-float-bubble")).toContainText("butter, always", { timeout: 20_000 });
    await game(pageB).locator(".wx-srv-float-fab").click();
    await expect(pageB.locator(".wx-srv-gamepop")).toContainText("salt or butter?");
    await expect(pageB.locator(".wx-srv-gamepop")).toContainText("butter, always");
    await pageB.locator(".wx-srv-gamepop-close").click();

    stopAwake();
    for (const e of errors) expect(e.filter((m) => !/favicon/i.test(m))).toEqual([]);
    await closeAll(contextA, contextB);
  });

  test("the game fits a 360 px phone with real tap targets", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 780 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await unlockServer(page, "Alice");
    await startCookout(page, false, false);
    // The intro card is itself a phone-sized modal: inside the viewport, its button a real target.
    const introCard = game(page).locator(".wx-srv-ck-intro:not([hidden]) .wx-srv-ck-intro-card");
    await expect(introCard).toBeVisible();
    const introBox = (await introCard.boundingBox())!;
    expect(introBox.x).toBeGreaterThanOrEqual(0);
    expect(introBox.x + introBox.width).toBeLessThanOrEqual(360.5);
    expect(introBox.y).toBeGreaterThanOrEqual(0);
    expect(introBox.y + introBox.height).toBeLessThanOrEqual(780.5);
    expect((await game(page).locator(".wx-srv-ck-intro-go").boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    await page.screenshot({ path: test.info().outputPath("phone-intro.png") });
    await dismissIntro(page);
    await expect(pickable(page)).toHaveCount(2);
    await page.screenshot({ path: test.info().outputPath("phone-picking.png") });

    // Nothing overflows sideways, and the page itself does not scroll (the table is a fixed grid).
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(pageOverflow).toBeLessThanOrEqual(1);
    const pageScroll = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    expect(pageScroll).toBeLessThanOrEqual(1);
    const paneFit = await game(page).evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(paneFit.scroll).toBeLessThanOrEqual(paneFit.client + 1);

    // Both picture cards, the Skip button, the progress button, the chat FAB and the tab bar are inside the viewport, and the
    // things a thumb has to hit are proper targets. Full screen: the composer is not at home.
    await expect(page.locator(".wx-srv-thread-view > .wx-chat-composer")).toBeHidden();
    for (const selector of [".wx-srv-ck-card", ".wx-srv-ck-skip", ".wx-srv-ck-progress", ".wx-srv-ck .wx-srv-float-fab", ".wx-srv-tab-chat", ".wx-srv-tab-cookout"]) {
      const box = (await page.locator(selector).first().boundingBox())!;
      expect(box, selector).not.toBeNull();
      expect(box.y + box.height, `${selector} bottom`).toBeLessThanOrEqual(780.5);
      expect(box.x, `${selector} left`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${selector} right`).toBeLessThanOrEqual(360.5);
    }
    for (const selector of [".wx-srv-ck-card", ".wx-srv-ck-skip", ".wx-srv-ck-progress", ".wx-srv-ck .wx-srv-float-fab", ".wx-srv-tab-chat", ".wx-srv-tab-cookout"]) {
      const box = (await page.locator(selector).first().boundingBox())!;
      expect(box.height, `${selector} height`).toBeGreaterThanOrEqual(43.5);
    }
    // The FAB never covers a play control: scrolled to the bottom, the last control ends above it.
    await game(page).locator(".wx-srv-ck-scroll").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const fab = (await page.locator(".wx-srv-ck .wx-srv-float-fab").boundingBox())!;
    for (const selector of [".wx-srv-ck-card", ".wx-srv-ck-skip", ".wx-srv-ck-progress"]) {
      for (const box of await Promise.all((await page.locator(selector).all()).map((l) => l.boundingBox()))) {
        if (box === null) continue;
        const overlaps = box.x < fab.x + fab.width && fab.x < box.x + box.width && box.y < fab.y + fab.height && fab.y < box.y + box.height;
        expect(overlaps, `${selector} under the FAB`).toBe(false);
      }
    }
    // The header (title, Recipe book, End, New, close) stays inside the phone.
    for (const selector of [".wx-srv-ck-book", ".wx-srv-ck-end", ".wx-srv-ck-close"]) {
      const box = (await page.locator(selector).boundingBox())!;
      expect(box.x + box.width, `${selector} right`).toBeLessThanOrEqual(360.5);
      // The header chips are phone touch targets (chat.css `.wx-srv-ck-chip`, 44 px).
      expect(box.height, `${selector} height`).toBeGreaterThanOrEqual(43.5);
    }
    const hit = await page.locator(".wx-srv-tab-chat").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top !== null && (top === el || el.contains(top));
    });
    expect(hit).toBe(true);
    await context.close();
  });
});
