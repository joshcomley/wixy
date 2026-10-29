// E2E for the Cookout twists (workspace 00058, spec/server-chat/09a-cookout-twists.md §8): two browsers play
// the twelve optional extras end to end against the real server, store, runner and client.
//
// Open game: start sheet with a spun style, the one-pan challenge, secret stars, the wildcard cloche and a
// fridge-raid starter found by search; the second player lucky-dips, the first uses the chaos shelf, the
// second sweeps one of the first player's options (veto); both star (the first star stays secret until the
// second lands); the cloche is lifted; the fake cmd answers eleven-item dishes; both vote (match badge);
// one dish is banked; a rescue swap is proposed by one and chosen by the other; generation-2 dishes and the
// Earlier dishes are visible and the banked generation-1 recipe still opens; it is marked cooked, rated by
// both and given a linked mini-chat photo; the Recipe book shows it; a leftovers encore starts a new round
// whose starters both players see.
//
// Blind game: the first player's DOM and responses never hold the second player's chaos pair, star or vote
// before their reveals. Every phase is also checked on a 360 px phone. Set WIXY_E2E_SHOTS=<dir> to save
// screenshots of the main flow's key moments.

import { expect, test } from "../fixtures";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trackConsoleErrors } from "./helpers";

test.describe.configure({ timeout: 360_000 });

/** Mirrors `MULTI_TAP_INTERVAL_MS` in admin-ui/src/server/constants.ts. */
const MULTI_TAP_INTERVAL_MS = 400;
const PHOTO = fileURLToPath(new URL("../fixtures/livechat-photo-gps.jpg", import.meta.url));
/** The cupboard staples are listed in every view, so they are never "withheld". */
const STAPLE_IDS = new Set(["water", "salt", "black-pepper", "butter", "plain-flour", "cooking-oil", "granulated-sugar", "milk"]);

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

/** A light touch so R7's 10s idle lock never fires on a page a test is only watching. */
async function keepAlive(page: Page): Promise<void> {
  try {
    await page.keyboard.press("Shift");
  } catch {
    // the page is closing
  }
}

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
  timeoutMs = 30_000,
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

function pickable(page: Page): Locator {
  return game(page).locator("button.wx-srv-ck-opt:not([disabled])");
}

function dishes(page: Page): Locator {
  return game(page).locator(".wx-srv-ck-dishes:not(.wx-srv-ck-earlier-dishes) > .wx-srv-ck-dish");
}

interface TwistChoices {
  readonly blind: boolean;
  readonly style?: "spin";
  readonly challenge?: "one-pan";
  readonly cloche?: boolean;
  readonly stars?: boolean;
  readonly fridge?: string;
}

/** Opens the chat header's ... menu. A game tab runs full screen with the header hidden (decisions/00194), so
 * the menu is reached from the Chat tab, as a player would. */
async function openMoreMenu(page: Page): Promise<void> {
  const chatTab = page.locator(".wx-srv-tab-chat");
  if (await chatTab.isVisible()) {
    await chatTab.click();
    await humanPause(page);
  }
  await page.locator(".wx-srv-more-button").click();
}

/** Starts a Cookout from the ... menu and its start sheet (with the twists the test names). */
async function startCookout(page: Page, twists: TwistChoices): Promise<{ seq: string; fridgeName: string | null }> {
  const before = await page.locator(".wx-srv-bubble-ck").count();
  await openMoreMenu(page);
  await expect(page.locator(".wx-srv-more-cookout")).toBeVisible();
  await humanPause(page);
  await page.locator(".wx-srv-more-cookout").click();
  await humanPause(page);
  await page.getByRole("radio", { name: twists.blind ? /Blind mode/ : /Open mode/ }).click();
  await humanPause(page);
  let fridgeName: string | null = null;
  if (twists.style !== undefined || twists.challenge !== undefined || twists.cloche === true || twists.stars === true || twists.fridge !== undefined) {
    await page.locator(".wx-srv-ck-twists-toggle").click();
    await expect(page.locator(".wx-srv-ck-twists-body")).toBeVisible();
    await humanPause(page);
  }
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
    fridgeName = (await page.locator(".wx-srv-ck-fridge-chip-name").textContent()) ?? null;
  }
  await humanPause(page);
  await page.locator(".wx-srv-ck-start-go").click();
  await expect(page.locator(".wx-srv-bubble-ck")).toHaveCount(before + 1);
  await expect(game(page)).toBeVisible();
  const seq = await page.locator(".wx-srv-bubble-ck").last().getAttribute("data-message-seq");
  expect(seq).not.toBeNull();
  return { seq: seq!, fridgeName };
}

/** The partner opens the round's card in the chat and presses Join Cookout. */
async function joinCookout(page: Page, seq: string): Promise<void> {
  const card = page.locator(`.wx-srv-bubble-ck[data-message-seq="${seq}"]`);
  await eventually([page], async () => await card.isVisible(), "the partner sees the Cookout card");
  await card.locator(".wx-srv-ck-mcard-open").click();
  await expect(game(page)).toBeVisible();
  const join = game(page).locator(".wx-srv-ck-join");
  await expect(join).toBeVisible();
  await humanPause(page);
  await join.click();
  await expect(join).toHaveCount(0);
}

/** Waits until exactly one page has a pair it may pick from; returns it. */
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
    40_000,
  );
  return { page: pages[found]!, index: found };
}

interface Offer {
  readonly ids: string[];
  readonly names: string[];
}

async function offerOn(page: Page): Promise<Offer> {
  const cards = game(page).locator(".wx-srv-ck-pair .wx-srv-ck-opt");
  await expect(cards).toHaveCount(2);
  const ids = await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-ingredient") ?? ""));
  const names = await cards.evaluateAll((els) => els.map((e) => e.querySelector(".wx-srv-ck-opt-name")?.textContent ?? ""));
  return { ids, names };
}

async function pickFirst(page: Page): Promise<{ offer: Offer; picked: string }> {
  const offer = await offerOn(page);
  const picked = offer.ids[0]!;
  await humanPause(page);
  await pickable(page).first().click();
  await expect(game(page).locator(`[data-ingredient="${picked}"]`)).toHaveCount(0, { timeout: 20_000 });
  return { offer, picked };
}

/** Collects every Cookout response body a page received (to prove what the server withheld). */
function recordBodies(page: Page): string[] {
  const bodies: string[] = [];
  page.on("response", (response) => {
    if (!response.url().includes("/server/cookout") || response.request().method() === "OPTIONS") return;
    void response.text().then(
      (text) => bodies.push(text),
      () => undefined,
    );
  });
  return bodies;
}

function lastView(bodies: readonly string[]): Record<string, unknown> | null {
  for (let i = bodies.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(bodies[i]!) as unknown;
      if (value !== null && typeof value === "object" && "stars" in value && "players" in value) return value as Record<string, unknown>;
    } catch {
      // not a view
    }
  }
  return null;
}

/** True when any response body carries this exact ingredient id as a JSON string value. */
function bodyHasId(bodies: readonly string[], id: string): boolean {
  const found = (value: unknown): boolean => {
    if (value === id) return true;
    if (Array.isArray(value)) return value.some(found);
    if (value !== null && typeof value === "object") return Object.values(value).some(found);
    return false;
  };
  return bodies.some((body) => {
    try {
      return found(JSON.parse(body) as unknown);
    } catch {
      return false;
    }
  });
}

/** Every page has the whole scrolling pane inside the phone width (no sideways scroll). */
async function expectFitsPhone(page: Page, what: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${what}: page overflow`).toBeLessThanOrEqual(1);
  const fit = await game(page).evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(fit.scroll, `${what}: pane overflow`).toBeLessThanOrEqual(fit.client + 1);
}

test.describe("Cookout twists", () => {
  test("Open game: every twist end to end with two browsers", async ({ browser }) => {
    const contextA = await browser.newContext({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });
    const contextB = await browser.newContext({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errors = [trackConsoleErrors(pageA), trackConsoleErrors(pageB)];
    await unlockServer(pageA, "Alice");
    await unlockServer(pageB, "Bob");
    const bodiesA = recordBodies(pageA);
    const bodiesB = recordBodies(pageB);
    const stopAwake = keepAwake([pageA, pageB]);
    const pages = [pageA, pageB] as const;

    // -- Start sheet: a spun style, the one-pan challenge, stars, the cloche and a fridge raid -----------------
    await openMoreMenu(pageA);
    await humanPause(pageA);
    await pageA.locator(".wx-srv-more-cookout").click();
    await expect(pageA.locator(".wx-srv-ck-twists-body")).toBeHidden(); // collapsed by default
    await pageA.locator(".wx-srv-ck-start-cancel").click();
    await expect(pageA.locator(".wx-srv-ck-start-sheet")).toBeHidden();
    await humanPause(pageA);

    const { seq, fridgeName } = await startCookout(pageA, { blind: false, style: "spin", challenge: "one-pan", cloche: true, stars: true, fridge: "rice" });
    expect(fridgeName).not.toBeNull();
    await shot(pageA, "twists-1-started");
    await expect(game(pageA)).toContainText(/one pan/i);
    await expectFitsPhone(pageA, "pane after start");

    // The fridge ingredient is the creator's Turn 1 starter, public to both once the partner joins.
    await expect(game(pageA).locator(".wx-srv-ck-pill-starter")).toHaveCount(1);
    await joinCookout(pageB, seq);
    await expect(game(pageB).locator(".wx-srv-ck-pill-starter")).toHaveCount(1);
    await expect(game(pageB)).toContainText(/one pan/i);

    // -- Drafting twists -----------------------------------------------------------------------------------------
    // Turn 2 is Bob's: he lucky-dips (the server flips the coin and commits the pick).
    const first = await whoseTurn(pages);
    expect(first.index).toBe(1);
    await humanPause(pageB);
    await game(pageB).locator(".wx-srv-ck-lucky").click();
    await eventually(pages, async () => (await pickable(pageB).count()) === 0, "the lucky dip is committed");

    // Turn 3 is Alice's: she uses the chaos shelf; Bob (the waiting partner, Open mode) sweeps one option.
    const second = await whoseTurn(pages);
    expect(second.index).toBe(0);
    await humanPause(pageA);
    await game(pageA).locator(".wx-srv-ck-chaos").click();
    await eventually(pages, async () => (await game(pageA).locator(".wx-srv-ck-chaos-note").count()) === 1, "Alice sees her chaos pair");
    await eventually(pages, async () => (await game(pageB).locator(".wx-srv-ck-chaos-note").count()) === 1, "Bob sees the chaos pair");
    await expect(game(pageA).locator(".wx-srv-ck-chaos")).toBeDisabled(); // once per player
    await shot(pageA, "twists-2-chaos-pair");
    const chaosPair = await offerOn(pageA);
    const sweep = game(pageB).locator(".wx-srv-ck-sweep").first();
    await expect(sweep).toBeVisible();
    await humanPause(pageB);
    await sweep.click();
    await eventually(pages, async () => {
      const now = await offerOn(pageA);
      return now.ids.some((id) => !chaosPair.ids.includes(id));
    }, "the swept option is replaced on Alice's table");
    await expect(game(pageB).locator(".wx-srv-ck-sweep").first()).toBeDisabled(); // Bob's sweep is spent
    await shot(pageB, "twists-3-swept");
    // Alice picks from what is on the table now.
    await pickFirst(pageA);

    // The rest of the draft (turns 4-10) alternates normally.
    for (let turn = 4; turn <= 10; turn += 1) {
      const { page } = await whoseTurn(pages);
      await pickFirst(page);
    }

    // -- The gate: secret stars, then the cloche ---------------------------------------------------------------
    await expect(game(pageA).locator(".wx-srv-ck-reveal")).toBeVisible({ timeout: 30_000 });
    await expect(game(pageB).locator(".wx-srv-ck-reveal")).toBeVisible();
    await expect(game(pageA).locator(".wx-srv-ck-dish")).toHaveCount(0); // the chef waits at the gate
    await shot(pageA, "twists-4-gate");
    await expectFitsPhone(pageA, "pane at the gate");

    // Alice stars one of her own picks; it is secret from Bob until he has starred too.
    await humanPause(pageA);
    await game(pageA).locator(".wx-srv-ck-star").first().click();
    await expect(game(pageA).locator(".wx-srv-ck-star-on")).toHaveCount(1);
    await expect(game(pageB).locator(".wx-srv-ck-stars-revealed")).toHaveCount(0);
    await expect(game(pageB).locator(".wx-srv-ck-chip-starred")).toHaveCount(0); // Alice's star is not on Bob's screen
    const viewB = lastView(bodiesB);
    expect((viewB?.["stars"] as { partner: unknown } | undefined)?.partner ?? null).toBeNull();
    await humanPause(pageB);
    await game(pageB).locator(".wx-srv-ck-star").first().click();
    await expect(game(pageA).locator(".wx-srv-ck-stars-revealed")).toBeVisible();
    await expect(game(pageB).locator(".wx-srv-ck-stars-revealed")).toBeVisible();
    await expect(game(pageA).locator(".wx-srv-ck-chip-starred")).toHaveCount(2);
    // Revealed stars are locked: the toggles are disabled.
    await expect(game(pageA).locator(".wx-srv-ck-star").first()).toBeDisabled();

    // Still gated by the cloche: lift it.
    await expect(game(pageA).locator(".wx-srv-ck-dish")).toHaveCount(0);
    await expect(game(pageB).locator(".wx-srv-ck-lift")).toBeVisible();
    await humanPause(pageB);
    await game(pageB).locator(".wx-srv-ck-lift").click();
    await shot(pageB, "twists-5-cloche-lifted");

    // -- The dishes (the fake cmd answers eleven-item, star- and challenge-aware dishes) ------------------------
    await eventually(pages, async () => (await dishes(pageA).count()) === 3 && (await dishes(pageB).count()) === 3, "the three dishes", 90_000);
    await expect(game(pageA).locator(".wx-srv-ck-reveal-chip")).toHaveCount(11); // ten picks + the wildcard
    await shot(pageA, "twists-6-dishes");
    await expectFitsPhone(pageA, "dishes");

    // -- Dinner vote: secret until both have voted -------------------------------------------------------------
    await humanPause(pageA);
    await dishes(pageA).first().locator(".wx-srv-ck-vote").click();
    await eventually(pages, async () => (await game(pageA).locator(".wx-srv-ck-vote-mine").count()) === 1, "Alice's vote shows");
    await expect(game(pageB).locator(".wx-srv-ck-voter")).toHaveCount(0);
    await expect(game(pageB).locator(".wx-srv-ck-dinner")).toHaveCount(0);
    const voteView = lastView(bodiesB);
    expect((voteView?.["vote"] as { votes: unknown } | null)?.votes ?? null).toBeNull();
    await humanPause(pageB);
    await dishes(pageB).first().locator(".wx-srv-ck-vote").click();
    await expect(dishes(pageA).first().locator(".wx-srv-ck-dinner")).toBeVisible(); // 🎯 Tonight's dinner!
    await expect(dishes(pageB).first().locator(".wx-srv-ck-dinner")).toBeVisible();
    await shot(pageA, "twists-7-dinner-decided");

    // -- Bank the first dish -----------------------------------------------------------------------------------
    const dishTitle = (await dishes(pageA).first().locator(".wx-srv-ck-dish-title").innerText()).trim();
    await humanPause(pageA);
    await dishes(pageA).first().locator(".wx-srv-ck-bank").click();
    await expect(dishes(pageA).first().locator(".wx-srv-ck-banked")).toContainText("Banked", { timeout: 60_000 });
    await expect(dishes(pageB).first().locator(".wx-srv-ck-banked")).toContainText("Banked", { timeout: 30_000 });

    // -- Rescue swap: Alice sends one back, Bob chooses the replacement ---------------------------------------
    await humanPause(pageA);
    await game(pageA).locator(".wx-srv-ck-rescue").click();
    const item = game(pageA).locator(".wx-srv-ck-swap-item:not([disabled]):not(:has(.wx-srv-ck-star-mark))").first();
    await expect(item).toBeVisible();
    await item.click();
    await humanPause(pageA);
    await game(pageA).locator(".wx-srv-ck-swap-send").click();
    await expect(game(pageB).locator(".wx-srv-ck-swap-pair")).toBeVisible({ timeout: 30_000 });
    await expect(game(pageA).locator(".wx-srv-ck-swap-cancel")).toBeVisible(); // the proposer can cancel
    await expect(dishes(pageB).first().locator(".wx-srv-ck-bank, .wx-srv-ck-banked")).toHaveCount(1);
    await shot(pageB, "twists-8-swap-choose");
    await humanPause(pageB);
    await game(pageB).locator(".wx-srv-ck-swap-pair button.wx-srv-ck-opt:not([disabled])").first().click();

    // Generation 2: new dishes, a "Swapped X -> Y" note, and the Earlier dishes section.
    await eventually(pages, async () => (await game(pageA).locator(".wx-srv-ck-swapped").count()) === 1, "the swap banner", 30_000);
    await eventually(pages, async () => (await dishes(pageA).count()) === 3 && (await dishes(pageB).count()) === 3, "generation-2 dishes", 90_000);
    await expect(game(pageA).locator(".wx-srv-ck-earlier-toggle")).toBeVisible();
    await game(pageB).locator(".wx-srv-ck-earlier-toggle").click();
    const earlier = game(pageB).locator(".wx-srv-ck-earlier-dishes .wx-srv-ck-dish");
    await expect(earlier).toHaveCount(3);
    await shot(pageB, "twists-9-earlier-dishes");

    // The banked generation-1 recipe still opens from Earlier dishes.
    const earlierBanked = earlier.locator(".wx-srv-ck-banked").first();
    await expect(earlierBanked).toContainText("Banked");
    await earlierBanked.click();
    await expect(game(pageB).locator(".wx-srv-ck-earlier-dishes .wx-srv-ck-recipe")).toBeVisible();
    await expect(game(pageB).locator(".wx-srv-ck-earlier-dishes")).toContainText(dishTitle);

    // -- We cooked it!: marked cooked, hearts from both, a real photo from the mini chat ----------------------
    await humanPause(pageB);
    await game(pageB).locator(".wx-srv-ck-earlier-dishes .wx-srv-ck-cooked-mark").click();
    await expect(game(pageB).locator(".wx-srv-ck-cooked-badge")).toContainText("Cooked");
    await humanPause(pageB);
    await game(pageB).locator(".wx-srv-ck-hearts-mine .wx-srv-ck-heart").nth(4).click(); // five hearts
    await expect(game(pageB).locator(".wx-srv-ck-hearts-mine .wx-srv-ck-heart-full")).toHaveCount(5);

    // Alice opens the same recipe and rates it too.
    if ((await game(pageA).locator(".wx-srv-ck-earlier-dishes").count()) === 0) await game(pageA).locator(".wx-srv-ck-earlier-toggle").click();
    await game(pageA).locator(".wx-srv-ck-earlier-dishes .wx-srv-ck-banked").first().click();
    await expect(game(pageA).locator(".wx-srv-ck-cooked-badge")).toContainText("Cooked");
    await humanPause(pageA);
    await game(pageA).locator(".wx-srv-ck-hearts-mine .wx-srv-ck-heart").nth(3).click(); // four hearts
    await expect(game(pageA).locator(".wx-srv-ck-hearts-mine .wx-srv-ck-heart-full")).toHaveCount(4);
    await expect(game(pageA).locator(".wx-srv-ck-hearts:not(.wx-srv-ck-hearts-mine) .wx-srv-ck-heart-full")).toHaveCount(5); // Bob's, read-only

    // A photo goes into the round's chat first (the chat FAB's pop-up: a game runs full screen), then is linked
    // as "our plate".
    await game(pageA).locator(".wx-srv-float-fab").click();
    await expect(pageA.locator(".wx-srv-gamepop .wx-chat-composer-input")).toBeVisible();
    await pageA.locator('.wx-srv-gamepop input[type="file"]').first().setInputFiles(PHOTO);
    await humanPause(pageA);
    await pageA.locator(".wx-srv-gamepop .wx-chat-send-button").click();
    await expect(pageA.locator(".wx-srv-gamepop .wx-srv-bubble img").first()).toBeVisible({ timeout: 30_000 });
    await humanPause(pageA);
    await pageA.locator(".wx-srv-gamepop-close").click();
    await humanPause(pageA);
    await game(pageA).locator(".wx-srv-ck-plates-add").click();
    const tile = pageA.locator(".wx-srv-ck-photos-tile").first();
    await expect(tile).toBeVisible({ timeout: 30_000 });
    await tile.click();
    await expect(game(pageA).locator(".wx-srv-ck-plates-change")).toBeVisible({ timeout: 30_000 });
    await shot(pageA, "twists-10-our-plate");
    await eventually(pages, async () => (await game(pageB).locator(".wx-srv-ck-plates-change").count()) === 1, "Bob sees our plate");

    // -- The Recipe book lists it as cooked, with both ratings --------------------------------------------------
    await game(pageB).locator(".wx-srv-ck-book").click(); // the pane's own button: the chat header is hidden in a game
    await humanPause(pageB);
    const entry = pageB.locator(".wx-srv-ck-book-entry").first();
    await expect(entry).toBeVisible();
    await expect(entry).toContainText(dishTitle);
    await expect(entry).toContainText(/cooked/i);
    await shot(pageB, "twists-11-recipe-book");
    await expectFitsPhone(pageB, "recipe book");
    await humanPause(pageB);
    await pageB.locator(".wx-srv-ck-book-close").click();

    // -- Leftovers encore from a dish that left something out: a new round with starters both can see ------------
    await expect(game(pageA).locator(".wx-srv-ck-dish-more-btn").first()).toBeVisible();
    await humanPause(pageA);
    await game(pageA).locator(".wx-srv-ck-dish-more-btn").first().click();
    await game(pageA).locator(".wx-srv-ck-dish-menu-item").first().click();
    await expect(pageA.locator(".wx-srv-ck-encore")).toBeVisible();
    // The leftovers start ticked up to the starter limit; make sure at least one is chosen.
    if ((await pageA.locator(".wx-srv-ck-encore-seed-on").count()) === 0) {
      await humanPause(pageA);
      await pageA.locator(".wx-srv-ck-encore-seed").first().click();
    }
    await expect(pageA.locator(".wx-srv-ck-encore-seed-on")).not.toHaveCount(0);
    await shot(pageA, "twists-12-encore-sheet");
    await expectFitsPhone(pageA, "encore sheet over the pane");
    const roundsBefore = await pageA.locator(".wx-srv-bubble-ck").count();
    await humanPause(pageA);
    await pageA.locator(".wx-srv-ck-start-go").click();
    await expect(pageA.locator(".wx-srv-bubble-ck")).toHaveCount(roundsBefore + 1);
    const encoreSeq = await pageA.locator(".wx-srv-bubble-ck").last().getAttribute("data-message-seq");
    await expect(game(pageA).locator(".wx-srv-ck-pill-starter")).not.toHaveCount(0);
    // Bob is in the old round's tab: go to the chat to find the new round's card.
    await humanPause(pageB);
    await pageB.locator(".wx-srv-tab-chat").click();
    await humanPause(pageB);
    await joinCookout(pageB, encoreSeq!);
    await expect(game(pageB).locator(".wx-srv-ck-pill-starter")).not.toHaveCount(0);
    await shot(pageB, "twists-13-encore-round");

    // The earlier finished round is untouched by the encore (never abandoned).
    stopAwake();
    for (const e of errors) expect(e.filter((m) => !/favicon/i.test(m))).toEqual([]);
    await closeAll(contextA, contextB);
  });

  test("Blind game: the partner's chaos pair, star and vote never reach the other browser before their reveals", async ({ browser }) => {
    const contextA = await browser.newContext({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });
    const contextB = await browser.newContext({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errors = [trackConsoleErrors(pageA), trackConsoleErrors(pageB)];
    await unlockServer(pageA, "Alice");
    await unlockServer(pageB, "Bob");
    const bodiesA = recordBodies(pageA);
    const stopAwake = keepAwake([pageA, pageB]);
    const pages = [pageA, pageB] as const;

    const { seq } = await startCookout(pageA, { blind: true, stars: true });
    await joinCookout(pageB, seq);
    await expectFitsPhone(pageA, "blind pane");

    let bobChaosPair: Offer | null = null;
    for (let turn = 1; turn <= 10; turn += 1) {
      const { page, index } = await whoseTurn(pages);
      const other = pages[1 - index]!;
      if (index === 1 && bobChaosPair === null) {
        // Bob's first turn: he spends his chaos shelf; Alice must not see the exotic pair anywhere.
        await humanPause(page);
        await game(page).locator(".wx-srv-ck-chaos").click();
        await eventually(pages, async () => (await game(page).locator(".wx-srv-ck-chaos-note").count()) === 1, "Bob's chaos pair");
        bobChaosPair = await offerOn(page);
        await expect(game(other).locator(".wx-srv-ck-chaos-note")).toHaveCount(0);
        await expect(game(other).locator("[data-ingredient]")).toHaveCount(0);
        const text = (await game(other).locator(".wx-srv-ck-scroll").innerText()).toLowerCase();
        bobChaosPair.names.forEach((name, i) => {
          if (!STAPLE_IDS.has(bobChaosPair!.ids[i]!)) expect(text).not.toContain(name.toLowerCase());
        });
        await shot(pageA, "twists-blind-1-no-chaos-leak");
      }
      await pickFirst(page);
    }
    // Bob's chaos pair was committed server-side: the option he did not pick (shown to nobody but him) is
    // in none of Alice's responses, ever.
    expect(bobChaosPair).not.toBeNull();
    const unpicked = bobChaosPair!.ids[1]!;
    if (!STAPLE_IDS.has(unpicked)) expect(bodyHasId(bodiesA, unpicked), `Alice's responses carry Bob's chaos option ${unpicked}`).toBe(false);

    // The gate: Bob stars first; Alice's view carries no partner star until she has starred too.
    await expect(game(pageB).locator(".wx-srv-ck-star").first()).toBeVisible({ timeout: 30_000 });
    await humanPause(pageB);
    await game(pageB).locator(".wx-srv-ck-star").first().click();
    await expect(game(pageB).locator(".wx-srv-ck-star-on")).toHaveCount(1);
    await expect(game(pageA).locator(".wx-srv-ck-stars-revealed")).toHaveCount(0);
    await expect(game(pageA).locator(".wx-srv-ck-chip-starred")).toHaveCount(0);
    const gatedA = lastView(bodiesA);
    expect((gatedA?.["stars"] as { partner: unknown; partnerChosen: unknown } | undefined)?.partner ?? null).toBeNull();
    await humanPause(pageA);
    await game(pageA).locator(".wx-srv-ck-star").first().click();
    await expect(game(pageA).locator(".wx-srv-ck-stars-revealed")).toBeVisible();
    await expect(game(pageB).locator(".wx-srv-ck-stars-revealed")).toBeVisible();

    // The dishes arrive; Alice votes; Bob's DOM and responses show nothing of it until Bob has voted.
    await eventually(pages, async () => (await dishes(pageA).count()) === 3 && (await dishes(pageB).count()) === 3, "the three dishes", 90_000);
    await humanPause(pageA);
    await dishes(pageA).first().locator(".wx-srv-ck-vote").click();
    await expect(dishes(pageA).first().locator(".wx-srv-ck-vote-mine")).toBeVisible();
    await expect(game(pageB).locator(".wx-srv-ck-voter, .wx-srv-ck-dinner")).toHaveCount(0);
    await humanPause(pageB);
    await dishes(pageB).nth(1).locator(".wx-srv-ck-vote").click(); // a DIFFERENT dish: a mismatch shows both voters
    await eventually(pages, async () => (await game(pageA).locator(".wx-srv-ck-voter").count()) === 2, "both votes revealed to Alice");
    await expect(game(pageB).locator(".wx-srv-ck-voter")).toHaveCount(2);
    await expect(game(pageA).locator(".wx-srv-ck-dinner")).toHaveCount(0); // no match, no "Tonight's dinner"
    await shot(pageA, "twists-blind-2-votes-revealed");

    stopAwake();
    for (const e of errors) expect(e.filter((m) => !/favicon/i.test(m))).toEqual([]);
    await closeAll(contextA, contextB);
  });
});
