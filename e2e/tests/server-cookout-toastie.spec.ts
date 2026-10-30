// E2E for the Cookout "Toasted sandwich" game mode (workspace 00058, spec/server-chat/09c-cookout-modes.md §8.6):
// two people (two browser contexts) at 360x640 start a Toasted sandwich round from the start sheet's mode
// tile and play it through with real clicks: the intro's toasted sandwich lines, "Your turn — pick the bread"
// and one skip, Player 2 joining, seven filling turns whose banners follow the plan (the three pair kinds in
// a shuffled order, each serving two turns in a row, then the finishing touch), no scrolling of the page or
// the stage at any turn, the reveal of eight picks with the bread first and butter free, the fake chef's three
// toasted sandwiches (build pills, "On <bread>", "Uses n/7 fillings"), "Bank this" and the Recipe book's
// badge. The Blind variant asserts the partner's DOM and responses never carry the starter's bread (name, id
// or picture URL) before the reveal.
//
// The fixture server enables the mode with WIXY_COOKOUT_MODES=toastie (e2e/fixture_server.py): in production
// it ships switched off. It has no ComfyUI, so pictures are the emoji tile; everything else is the real
// server, store, runner and client. Every wait is on an observable state, never a fixed sleep (the short
// `humanPause` only lets the double-tap lock window pass). The whole Open flow runs a second time with the
// wide-font stress and the 34 px bottom inset (spec/server-chat/09b §F.3).

import { expect, test } from "../fixtures";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { trackConsoleErrors } from "./helpers";

test.describe.configure({ timeout: 240_000 });

/** Mirrors `MULTI_TAP_INTERVAL_MS` in admin-ui/src/server/constants.ts. */
const MULTI_TAP_INTERVAL_MS = 400;

/** The same stress as server-cookout.spec.ts: every glyph of the pane is widened by a fixed letter-spacing. */
const WIDE_FONT_STRESS = ".wx-srv-ck, .wx-srv-ck * { letter-spacing: 0.15em !important; }";

const PHONE = { width: 360, height: 640 } as const;

const FILLING_PROMPTS = ["add a cheese", "add a main filling", "add veg or fruit"] as const;

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

/** Keeps every page awake for the whole of a test (stop it before closing the contexts). */
function keepAwake(pages: readonly Page[]): () => void {
  const timer = setInterval(() => {
    for (const page of pages) void keepAlive(page);
  }, 2500);
  return () => clearInterval(timer);
}

async function eventually(pages: readonly Page[], check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
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

async function setStyle(page: Page, id: string, css: string): Promise<void> {
  await page.evaluate(
    ([styleId, text]) => {
      let style = document.getElementById(styleId);
      if (style === null) {
        style = document.createElement("style");
        style.id = styleId;
        document.head.append(style);
      }
      style.textContent = text;
    },
    [id, css] as const,
  );
}

function game(page: Page): Locator {
  return page.locator('.wx-srv-ck[data-game="cookout"]');
}

/** The two picture cards the active player may tap (a watcher's cards are plain divs, not buttons). */
function pickable(page: Page): Locator {
  return game(page).locator(".wx-srv-ck-pair button.wx-srv-ck-card:not([disabled])");
}

async function dismissIntro(page: Page): Promise<string[]> {
  const intro = game(page).locator(".wx-srv-ck-intro:not([hidden])");
  await expect(intro).toBeVisible();
  const lines = await intro.locator(".wx-srv-ck-intro-line").allInnerTexts();
  await humanPause(page);
  await intro.locator(".wx-srv-ck-intro-go").click();
  await expect(intro).toHaveCount(0);
  await humanPause(page);
  return lines.map((line) => line.trim());
}

async function openMoreMenu(page: Page): Promise<void> {
  const chatTab = page.locator(".wx-srv-tab-chat");
  if (await chatTab.isVisible()) {
    await chatTab.click();
    await humanPause(page);
  }
  await page.locator(".wx-srv-more-button").click();
}

/** Starts a Toasted sandwich Cookout from the ... menu: opens the start sheet, picks the mode's tile (and
 * checks the Classic tile was the default), chooses Open or Blind play and starts. Returns the message seq
 * and the intro card's lines. */
async function startToastie(page: Page, blind: boolean): Promise<{ seq: string; intro: string[] }> {
  const before = await page.locator(".wx-srv-bubble-ck").count();
  await openMoreMenu(page);
  await expect(page.locator(".wx-srv-more-cookout")).toBeVisible();
  await humanPause(page);
  await page.locator(".wx-srv-more-cookout").click();
  const tiles = page.locator(".wx-srv-ck-mtile");
  await expect(tiles).toHaveCount(2);
  await expect(page.locator('.wx-srv-ck-mtile[data-mode-id="classic"]')).toHaveAttribute("aria-checked", "true");
  const tile = page.locator('.wx-srv-ck-mtile[data-mode-id="toastie"]');
  await expect(tile).toContainText("Toasted sandwich");
  await humanPause(page);
  await tile.click();
  await expect(tile).toHaveAttribute("aria-checked", "true");
  await humanPause(page);
  const play = page.getByRole("radio", { name: blind ? /Blind mode/ : /Open mode/ });
  await expect(play).toBeVisible();
  await play.click();
  await humanPause(page);
  await page.locator(".wx-srv-ck-start-go").click();
  await expect(page.locator(".wx-srv-bubble-ck")).toHaveCount(before + 1);
  await expect(game(page)).toBeVisible();
  const seq = await page.locator(".wx-srv-bubble-ck").last().getAttribute("data-message-seq");
  expect(seq).not.toBeNull();
  return { seq: seq!, intro: await dismissIntro(page) };
}

async function joinCookout(page: Page, seq: string): Promise<string[]> {
  const card = page.locator(`.wx-srv-bubble-ck[data-message-seq="${seq}"]`);
  await eventually([page], async () => await card.isVisible(), "the partner sees the Cookout card");
  await card.locator(".wx-srv-ck-mcard-open").click();
  await expect(game(page)).toBeVisible();
  const intro = await dismissIntro(page);
  const join = game(page).locator(".wx-srv-ck-banner .wx-srv-ck-join");
  await expect(join).toBeVisible();
  await humanPause(page);
  await join.click();
  await expect(join).toHaveCount(0);
  return intro;
}

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
  /** Every `src` of a picture on the cards (empty in the fixture, which has no ComfyUI). */
  readonly pictures: string[];
}

async function offerOn(page: Page): Promise<Offer> {
  const cards = game(page).locator(".wx-srv-ck-pair .wx-srv-ck-card");
  await expect(cards).toHaveCount(2);
  const ids = await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-ingredient") ?? ""));
  const names = await cards.evaluateAll((els) => els.map((e) => e.querySelector(".wx-srv-ck-card-name")?.textContent ?? ""));
  const pictures = await cards.evaluateAll((els) =>
    els.flatMap((e) => [...e.querySelectorAll("img")].map((img) => img.getAttribute("src") ?? "")).filter((src) => src !== ""),
  );
  return { ids, names, pictures };
}

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

/** True when the screen text shows this name as whole words. */
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

interface PaneFit {
  readonly paneHeight: number;
  readonly paneScrolls: boolean;
  readonly stageScrolls: boolean;
  readonly pageScrolls: boolean;
}

/** Whether the page, the pane or (where the pane is tall enough for the stage never to scroll) the stage
 * overflows. spec 09b §D.3: below a 411 px pane only the stage may scroll, on its own. */
async function paneFit(page: Page): Promise<PaneFit> {
  return await page.evaluate((): PaneFit => {
    const pane = document.querySelector<HTMLElement>('.wx-srv-ck[data-game="cookout"]');
    const stage = pane?.querySelector<HTMLElement>(".wx-srv-ck-table-stage") ?? null;
    return {
      paneHeight: pane?.getBoundingClientRect().height ?? 0,
      paneScrolls: pane !== null && pane.scrollHeight > pane.clientHeight + 1,
      stageScrolls: stage !== null && stage.scrollHeight > stage.clientHeight + 1,
      pageScrolls: (document.scrollingElement?.scrollHeight ?? 0) > innerHeight,
    };
  });
}

async function expectNoScroll(page: Page, where: string): Promise<void> {
  const fit = await paneFit(page);
  expect(fit.paneHeight, `${where}: the pane is on screen`).toBeGreaterThan(0);
  expect(fit.pageScrolls, `${where}: the page scrolls`).toBe(false);
  expect(fit.paneScrolls, `${where}: the pane scrolls`).toBe(false);
  if (fit.paneHeight >= 411) expect(fit.stageScrolls, `${where}: the stage scrolls (pane ${fit.paneHeight}px)`).toBe(false);
}

async function dishCount(page: Page): Promise<number> {
  return await game(page).locator(".wx-srv-ck-dish").count();
}

/** The bread turn's banner: the active player's line 1 and line 2. */
async function banner(page: Page): Promise<{ line1: string; line2: string }> {
  const line1 = (await game(page).locator(".wx-srv-ck-banner .wx-srv-ck-turn").innerText()).trim();
  const sub = game(page).locator(".wx-srv-ck-banner .wx-srv-ck-turn-sub");
  const line2 = (await sub.count()) === 0 ? "" : (await sub.innerText()).trim();
  return { line1, line2 };
}

/** Page-wide text and markup, for "never in the DOM" checks. */
async function wholeDom(page: Page): Promise<{ text: string; html: string }> {
  return await page.evaluate(() => ({ text: document.body.innerText, html: document.documentElement.outerHTML }));
}

test.describe("Cookout: Toasted sandwich", () => {
  for (const stress of [false, true]) {
    test(`Open play${stress ? " with the wide-font stress and a 34 px inset" : ""}: bread, seven fillings, three toasted sandwiches, Bank this and the Recipe book`, async ({
      browser,
    }) => {
      const contextA = await browser.newContext({ viewport: PHONE });
      const contextB = await browser.newContext({ viewport: PHONE });
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();
      const errors = [trackConsoleErrors(pageA), trackConsoleErrors(pageB)];
      const stopAwake = keepAwake([pageA, pageB]);
      await unlockServer(pageA, "Alice");
      await unlockServer(pageB, "Bob");
      const pages = [pageA, pageB] as const;
      const applyStress = async (): Promise<void> => {
        if (!stress) return;
        for (const page of pages) {
          await setStyle(page, "e2e-wide-font", WIDE_FONT_STRESS);
          await setStyle(page, "e2e-inset", ".wx-srv-tabs { padding-bottom: 34px !important }");
        }
      };
      await applyStress();

      // Start from the mode tile; the intro says what this round is.
      const { seq, intro: introA } = await startToastie(pageA, false);
      await applyStress();
      expect(introA[0]).toBe("You're making a toasted sandwich.");
      expect(introA.join(" ")).toMatch(/You pick the bread first, then you take turns adding fillings — 4 picks each\./);
      expect(introA.join(" ")).toMatch(/non-blind mode/i);
      expect(introA[introA.length - 1]).toBe("The chef makes three toasted sandwiches with your bread.");
      await expect(game(pageA).locator(".wx-srv-ck-badge")).toHaveText("Open");
      await expect(game(pageA).locator(".wx-srv-ck-title")).toHaveAttribute("aria-label", "Toasted sandwich Cookout");
      await expect(chatCard(pageA, seq).locator(".wx-srv-ck-mcard-status")).toContainText("Picking ingredients (0/8)");

      // Turn 1: the bread, with the usual two skips. One skip: a new pair of breads.
      await expect(pickable(pageA)).toHaveCount(2);
      await expect(game(pageA).locator(".wx-srv-ck-turn")).toHaveText("Your turn — pick the bread");
      await expect(game(pageA).locator(".wx-srv-ck-turn-sub")).toContainText("Bread · then 7 fillings · 2 new pairs left");
      await expect(game(pageA).locator(".wx-srv-ck-prog-slot")).toHaveCount(8);
      await expect(game(pageA).locator(".wx-srv-ck-prog-anchor .wx-srv-ck-prog-mark")).toHaveText("🍞");
      await expectNoScroll(pageA, "turn 1, first pair");
      const firstBreads = await offerOn(pageA);
      const skip = game(pageA).locator(".wx-srv-ck-skip");
      await expect(skip).toHaveText("Deal two new ones (2 left)");
      await humanPause(pageA);
      await skip.click();
      await expect(game(pageA).locator(".wx-srv-ck-pair")).toHaveAttribute("data-offer", "1");
      await expect(skip).toHaveText("Deal two new ones (1 left)");
      await expect(game(pageA).locator(".wx-srv-ck-turn-sub")).toContainText("1 new pair left");
      const secondBreads = await offerOn(pageA);
      expect(secondBreads.ids.filter((id) => firstBreads.ids.includes(id))).toEqual([]);
      await expectNoScroll(pageA, "turn 1, second pair");

      const bread = await pickFirst(pageA);
      const breadName = bread.pickedName;
      await expect(game(pageA).locator(".wx-srv-ck-progress")).toHaveAttribute("aria-label", new RegExp(`Bread: ${breadName}\\.`));
      await expect(game(pageA).locator(".wx-srv-ck-prog-anchor.wx-srv-ck-prog-full")).toHaveCount(1);
      // Bob has not joined: turn 2 is never drawn until he does.
      await expect(game(pageA).locator(".wx-srv-ck-turn")).toContainText("to join");
      await expect(pickable(pageA)).toHaveCount(0);

      const introB = await joinCookout(pageB, seq);
      await applyStress();
      expect(introB.join(" ")).toMatch(/Alice picks the bread first, then you take turns adding fillings — 4 picks each\./);

      // Turns 2-8: the seven fillings alternate Bob, Alice, ... and follow the plan: three pair kinds in a
      // shuffled order, each for two turns in a row, then the finishing touch for Bob.
      const kinds: string[] = [];
      const picked: string[] = [breadName];
      const order: number[] = [0];
      for (let turn = 2; turn <= 8; turn += 1) {
        const { page: active, index } = await whoseTurn(pages);
        const watcher = pages[1 - index]!;
        order.push(index);
        const words = await banner(active);
        const prompt = /^Your turn — (.+)$/.exec(words.line1)?.[1] ?? "";
        kinds.push(prompt);
        expect(words.line2, `turn ${turn}: the position line`).toContain(`Filling ${turn - 1} of 7`);
        const activeName = index === 0 ? "Alice" : "Bob";
        await expect(game(watcher).locator(".wx-srv-ck-turn"), `turn ${turn}: the watcher's banner`).toHaveText(`${activeName} is adding a filling…`);
        await expectNoScroll(active, `turn ${turn} (active)`);
        await expectNoScroll(watcher, `turn ${turn} (watcher)`);
        const result = await pickFirst(active);
        picked.push(result.pickedName);
      }
      expect(order).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
      expect(kinds[kinds.length - 1]).toBe("add a finishing touch");
      const pairKinds = kinds.slice(0, 6);
      expect(pairKinds[0]).toBe(pairKinds[1]);
      expect(pairKinds[2]).toBe(pairKinds[3]);
      expect(pairKinds[4]).toBe(pairKinds[5]);
      expect([pairKinds[0], pairKinds[2], pairKinds[4]].sort()).toEqual([...FILLING_PROMPTS].sort());

      // The chef's three toasted sandwiches appear for both.
      await eventually(pages, async () => (await dishCount(pageA)) === 3 && (await dishCount(pageB)) === 3, "the three toasted sandwiches", 60_000);
      for (const page of pages) {
        const reveal = game(page).locator(".wx-srv-ck-reveal");
        await expect(reveal.locator(".wx-srv-ck-rtile")).toHaveCount(8);
        // The bread has its own first row; the fillings follow.
        const groups = reveal.locator(".wx-srv-ck-rgroup");
        await expect(groups.first()).toHaveAttribute("data-group", "anchor");
        await expect(groups.first().locator(".wx-srv-ck-rgroup-who")).toHaveText("Bread");
        await expect(groups.first().locator(".wx-srv-ck-rtile")).toHaveCount(1);
        await expect(groups.first()).toContainText(breadName);
        for (const name of picked) await expect(reveal).toContainText(name);
        // Butter is free in this mode and listed first.
        await expect(reveal.locator(".wx-srv-ck-staples-list > *").first()).toContainText(/butter/i);
        await expect(reveal.locator(".wx-srv-ck-staple-free-tag")).toHaveCount(1);
        await expect(game(page).locator(".wx-srv-ck-stagehead")).toContainText("Toasted sandwich");
        await expect(game(page).locator(".wx-srv-ck-stagehead")).toContainText("🥪");
      }

      // Each dish: a build pill, a different build each, "On <bread>", "Uses n/7 fillings" and a picture.
      const builds = await game(pageA).locator(".wx-srv-ck-dish .wx-srv-ck-tag-build").allInnerTexts();
      expect(builds).toHaveLength(3);
      expect(new Set(builds.map((b) => b.trim())).size).toBe(3);
      for (const page of pages) {
        const dishes = game(page).locator(".wx-srv-ck-dish");
        for (let i = 0; i < 3; i += 1) {
          const dish = dishes.nth(i);
          await expect(dish.locator(".wx-srv-ck-tag-build")).toHaveCount(1);
          await expect(dish.locator(".wx-srv-ck-dish-anchor-name")).toHaveText(`On ${breadName}`);
          await expect(dish.locator(".wx-srv-ck-uses-count")).toHaveText(/^Uses [5-7]\/7 fillings$/);
          await expect(dish.locator(".wx-srv-ck-dish-pic")).toHaveCount(1);
        }
      }
      await expect(chatCard(pageA, seq).locator(".wx-srv-ck-mcard-status")).toContainText("3 toasted sandwich ideas ready");

      // Bank this: Alice banks the first one; "Banked" on both screens, with the full recipe's build label.
      const title = (await game(pageA).locator(".wx-srv-ck-dish-title").first().innerText()).trim();
      await humanPause(pageA);
      await game(pageA).locator(".wx-srv-ck-dish").first().locator(".wx-srv-ck-bank").click();
      const bankedA = game(pageA).locator(".wx-srv-ck-dish").first().locator(".wx-srv-ck-banked");
      const bankedB = game(pageB).locator(".wx-srv-ck-dish").first().locator(".wx-srv-ck-banked");
      await expect(bankedA).toContainText("Banked", { timeout: 60_000 });
      await expect(bankedB).toContainText("Banked", { timeout: 20_000 });
      await humanPause(pageB);
      await bankedB.click();
      const recipe = game(pageB).locator(".wx-srv-ck-recipe");
      await expect(recipe).toBeVisible();
      expect(await recipe.locator(".wx-srv-ck-recipe-ing").count()).toBeGreaterThan(0);
      expect(await recipe.locator(".wx-srv-ck-recipe-step").count()).toBeGreaterThan(0);
      await expect(recipe.locator(".wx-srv-ck-recipe-build")).toHaveText(builds[0]!.trim());

      // The Recipe book lists it with the sandwich badge.
      await game(pageB).locator(".wx-srv-ck-book").click();
      await humanPause(pageB);
      const entries = pageB.locator(".wx-srv-ck-book-entry");
      await expect(entries).toHaveCount(1);
      await expect(entries.first()).toContainText(title);
      await expect(entries.first().locator(".wx-srv-ck-book-mode")).toHaveText("🥪");

      stopAwake();
      for (const e of errors) expect(e.filter((m) => !/favicon/i.test(m))).toEqual([]);
      await closeAll(contextA, contextB);
    });
  }

  test("Blind play: the partner's DOM and responses never carry the starter's bread (name, id or picture) before the reveal", async ({ browser }) => {
    const contextA = await browser.newContext({ viewport: PHONE });
    const contextB = await browser.newContext({ viewport: PHONE });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errors = [trackConsoleErrors(pageA), trackConsoleErrors(pageB)];
    const stopAwake = keepAwake([pageA, pageB]);
    await unlockServer(pageA, "Alice");
    await unlockServer(pageB, "Bob");
    const bodiesB = recordBodies(pageB);
    const pages = [pageA, pageB] as const;

    const { seq, intro } = await startToastie(pageA, true);
    expect(intro.join(" ")).toMatch(/secret — the toasted sandwich is revealed when all eight are in/i);
    await expect(game(pageA).locator(".wx-srv-ck-badge")).toHaveText("Blind");
    await joinCookout(pageB, seq);

    // Alice's bread turn. Bob already shows a secret turn: no kind, no breads.
    await expect(pickable(pageA)).toHaveCount(2);
    const breadOffer = await offerOn(pageA);
    await eventually(pages, async () => (await game(pageB).locator(".wx-srv-ck-cloche").count()) === 1, "Bob shows a secret turn");
    await expect(game(pageB).locator("[data-ingredient]")).toHaveCount(0);
    await expect(game(pageB).locator(".wx-srv-ck-turn")).toHaveText("Alice is choosing…");
    await expectNoScroll(pageB, "Bob during Alice's bread turn");

    const bread = await pickFirst(pageA);
    const breadId = bread.picked;
    const breadName = bread.pickedName;
    const hidden = [...breadOffer.pictures];

    const checkHidden = async (when: string): Promise<void> => {
      const dom = await wholeDom(pageB);
      expect(textShows(dom.text, breadName), `${when}: "${breadName}" is on Bob's screen`).toBe(false);
      // The full markup too: hidden nodes and every attribute (alt, aria-label, title, data-*), whole word.
      expect(textShows(dom.html, breadName), `${when}: "${breadName}" is in Bob's markup`).toBe(false);
      for (const id of breadOffer.ids) expect(dom.html.includes(`"${id}"`), `${when}: ${id} is in Bob's DOM`).toBe(false);
      for (const src of hidden) expect(dom.html.includes(src), `${when}: ${src} is in Bob's DOM`).toBe(false);
      const bodies = bodiesB.join("\n");
      for (const id of breadOffer.ids) expect(bodies.includes(`"${id}"`), `${when}: ${id} is in Bob's responses`).toBe(false);
      for (const src of hidden) expect(bodies.includes(src), `${when}: ${src} is in Bob's responses`).toBe(false);
    };

    // Seven more turns; after each of them Bob still has nothing of Alice's bread (nor, before the last, any of
    // the unrevealed picks): the bread slot is a lock with the bread mark, the label says "Secret bread".
    for (let turn = 2; turn <= 8; turn += 1) {
      const { page: active, index } = await whoseTurn(pages);
      if (turn >= 2 && index === 1) {
        // Bob's own turn: Alice sees only "is choosing…", never the kind.
        await expect(game(pageA).locator(".wx-srv-ck-turn")).toHaveText("Bob is choosing…");
      }
      await checkHidden(`turn ${turn}`);
      await expect(game(pageB).locator(".wx-srv-ck-progress")).toHaveAttribute("aria-label", /Basket so far: .*Secret bread\./);
      await expect(game(pageB).locator(".wx-srv-ck-prog-anchor.wx-srv-ck-prog-secret")).toHaveText(/🔒/);
      await expect(game(pageB).locator(".wx-srv-ck-prog-anchor .wx-srv-ck-prog-mark")).toHaveText("🍞");
      await expectNoScroll(active, `turn ${turn} (active)`);
      await expectNoScroll(pages[1 - index]!, `turn ${turn} (watcher)`);
      await pickFirst(active);
    }

    // All eight are in: both screens reveal the whole basket, bread first, and Bob finally knows the bread.
    await eventually(pages, async () => (await dishCount(pageA)) === 3 && (await dishCount(pageB)) === 3, "the three toasted sandwiches", 60_000);
    for (const page of pages) {
      const reveal = game(page).locator(".wx-srv-ck-reveal");
      await expect(reveal.locator(".wx-srv-ck-rtile")).toHaveCount(8);
      await expect(reveal.locator(".wx-srv-ck-reveal-title")).toContainText("big reveal");
      await expect(reveal.locator(".wx-srv-ck-rgroup").first()).toHaveAttribute("data-group", "anchor");
      await expect(reveal.locator(".wx-srv-ck-rgroup").first()).toContainText(breadName);
      await expect(game(page).locator(".wx-srv-ck-dish-anchor-name").first()).toHaveText(`On ${breadName}`);
    }
    expect(bodiesB.join("\n").includes(`"${breadId}"`)).toBe(true);

    stopAwake();
    for (const e of errors) expect(e.filter((m) => !/favicon/i.test(m))).toEqual([]);
    await closeAll(contextA, contextB);
  });
});

/** The chat card of the round with this message seq. */
function chatCard(p: Page, seq: string): Locator {
  return p.locator(`.wx-srv-bubble-ck[data-message-seq="${seq}"]`);
}
