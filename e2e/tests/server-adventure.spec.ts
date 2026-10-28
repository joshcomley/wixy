// E2E for Adventure Time, the globe holiday game (workspace 00056, spec/server-chat/08-adventure-time.md §6):
// two people play a whole adventure with REAL mouse drags on the globe. One spins it sideways and then
// up/down (the other sees the finger's trail while it moves, and the same spin and landing after), both
// press a Stop (each screen lights the same country, then the same place), the fake cmd researcher
// returns the canned holiday pack, the destination has its own mini chat (shared with every game), the
// trip is banked and appears in the Holiday bank screen; a rejected place is confirmed and never
// returns; Adventure and Would-you-rather replace each other in the tab bar (only ever two tabs); and
// the pane fits a 360 px phone.
//
// The globe is a canvas, so the tests read the pane's own `data-*` facts (`data-state`, `data-phase`,
// `data-lit`, `data-landing-unit`, `data-country`, `data-place`, `data-pack-state`, `data-remote`),
// which the pane keeps in step with what it draws. Set WIXY_E2E_SHOTS=<dir> to also save 390 px
// screenshots of the main flow's key moments.

import { expect, test } from "../fixtures";
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { trackConsoleErrors } from "./helpers";

test.describe.configure({ timeout: 240_000 });

/** Mirrors `MULTI_TAP_INTERVAL_MS` in admin-ui/src/server/constants.ts. */
const MULTI_TAP_INTERVAL_MS = 400;
/** The canned pack the fake cmd researcher returns (wixy_server/tests/fake_cmd.py `CANNED_ADVENTURE_PACK`). */
const CANNED_HEADLINE = "Sun, tiles and custard tarts on the Atlantic edge of Europe";

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
 * as activity and, unlike a mouse move, cannot disturb a drag another call is making on the same page. */
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

function adv(page: Page): Locator {
  return page.locator(".wx-srv-adv");
}

async function fact(page: Page, name: string): Promise<string> {
  return (await adv(page).getAttribute(`data-${name}`)) ?? "";
}

/** Waits until a pane fact has (or does not have) a value on every page. */
async function waitFact(pages: readonly Page[], name: string, value: string, timeoutMs = 20_000): Promise<void> {
  for (const page of pages) {
    await eventually(pages, async () => (await fact(page, name)) === value, `data-${name}=${value}`, timeoutMs);
  }
}

async function waitFactSet(pages: readonly Page[], name: string, timeoutMs = 20_000): Promise<void> {
  for (const page of pages) {
    await eventually(pages, async () => (await fact(page, name)) !== "", `data-${name} set`, timeoutMs);
  }
}

/** Starts an adventure from the ... menu; the starter lands in the Adventure tab. Returns the anchor seq. */
async function startAdventure(page: Page): Promise<string> {
  const before = await page.locator(".wx-srv-bubble-adv").count();
  await page.locator(".wx-srv-more-button").click();
  await expect(page.locator(".wx-srv-more-adventure")).toBeVisible();
  await humanPause(page);
  await page.locator(".wx-srv-more-adventure").click();
  await expect(page.locator(".wx-srv-bubble-adv")).toHaveCount(before + 1);
  const seq = await page.locator(".wx-srv-bubble-adv").last().getAttribute("data-message-seq");
  expect(seq).not.toBeNull();
  return seq!;
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

/** The screenshot run (WIXY_E2E_SHOTS) plays on the real satellite map, whose software-GL frames are
 * too slow for a mouse flick to keep its timing: it flicks with in-page pointer events instead. */
function shotsRun(): boolean {
  const dir = process.env["WIXY_E2E_SHOTS"];
  return dir !== undefined && dir !== "";
}

/** A browser context that plays on the flat Classic map (fast to draw, so the timing of a real mouse
 * flick holds even on a software-GL CI runner), unless this is the screenshot run. */
async function newGameContext(browser: Browser, options: BrowserContextOptions = PHONE): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  if (!shotsRun()) {
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem("wixy.adventure.mapStyle", "classic");
      } catch {
        // storage blocked: the default style it is
      }
    });
  }
  return context;
}

/**
 * A drag on the globe: a slow part (so a watcher can see the finger move), then a quick flick and the
 * release. `axis` lng drags sideways, lat drags up. With a REAL mouse (`page.mouse`), except in the
 * screenshot run.
 */
async function dragGlobe(page: Page, axis: "lng" | "lat", whileFingerDown?: () => Promise<void>): Promise<void> {
  const box = (await page.locator(".wx-srv-adv-globe").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const r = 0.45 * Math.min(box.width, box.height);
  const at = (t: number): { x: number; y: number } =>
    axis === "lng"
      ? { x: cx - r * 0.6 + r * 1.2 * t, y: cy + r * 0.15 }
      : { x: cx + r * 0.15, y: cy + r * 0.6 - r * 1.2 * t };
  const slow = [1, 2, 3, 4, 5, 6].map((i) => at((0.4 * i) / 6));
  const fast = [1, 2, 3, 4].map((i) => at(0.4 + (0.6 * i) / 4));
  if (shotsRun()) {
    // In-page pointer events with EXPLICIT timestamps (a flick's speed comes from the time between its
    // last samples, and software-GL frames would stretch real timing): the same finger, exactly timed.
    await page.evaluate(
      async ({ start, moves }) => {
        const canvas = document.querySelector(".wx-srv-adv-globe")!;
        const fire = (type: string, p: { x: number; y: number }, timeStamp: number): void => {
          const event = new PointerEvent(type, { pointerId: 7, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true });
          Object.defineProperty(event, "timeStamp", { value: timeStamp });
          canvas.dispatchEvent(event);
        };
        fire("pointerdown", start, performance.now());
        for (const p of moves) {
          fire("pointermove", p, performance.now());
          await new Promise((resolve) => setTimeout(resolve, 90));
        }
      },
      { start: at(0), moves: slow },
    );
    if (whileFingerDown !== undefined) await whileFingerDown();
    await page.evaluate(
      ({ moves }) => {
        const canvas = document.querySelector(".wx-srv-adv-globe")!;
        const fire = (type: string, p: { x: number; y: number }, timeStamp: number): void => {
          const event = new PointerEvent(type, { pointerId: 7, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true });
          Object.defineProperty(event, "timeStamp", { value: timeStamp });
          canvas.dispatchEvent(event);
        };
        const t0 = performance.now();
        moves.forEach((p, i) => fire("pointermove", p, t0 + i * 14));
        fire("pointerup", moves[moves.length - 1]!, t0 + (moves.length - 1) * 14 + 4);
      },
      { moves: fast },
    );
    return;
  }
  await page.mouse.move(at(0).x, at(0).y);
  await page.mouse.down();
  for (const p of slow) {
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(90);
  }
  if (whileFingerDown !== undefined) await whileFingerDown();
  // No wait after the last move: a finger that rests for more than 60 ms before it lifts is not a flick.
  for (const [i, p] of fast.entries()) {
    await page.mouse.move(p.x, p.y);
    if (i < fast.length - 1) await page.waitForTimeout(14);
  }
  await page.mouse.up();
}

/**
 * A drag that MUST turn into a spin: a real mouse flick's speed comes from the time between its last
 * events, and on a busy machine one of those can arrive late and make it a weak swipe ("Flick it
 * harder!"). A person would simply flick again, and so does this: up to four attempts, the finger-down
 * hook only on the first.
 */
async function flickGlobe(page: Page, axis: "lng" | "lat", whileFingerDown?: () => Promise<void>): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await dragGlobe(page, axis, attempt === 1 ? whileFingerDown : undefined);
    const turned = Date.now() + 1500;
    while (Date.now() < turned) {
      const phase = await fact(page, "phase");
      if (phase === "spin1" || phase === "spin2") return;
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(MULTI_TAP_INTERVAL_MS + 100); // (a person's pause; and no accidental multi-tap)
  }
  throw new Error(`the ${axis} flick never turned into a spin`);
}

/** Remembers which item was lit the instant Stop is pressed (what you see is what you get). */
async function armLitAtPress(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __litAtPress?: string };
    w.__litAtPress = undefined;
    const stop = document.querySelector(".wx-srv-adv-stop");
    const pane = document.querySelector(".wx-srv-adv");
    stop?.addEventListener(
      "pointerdown",
      () => {
        w.__litAtPress = pane?.getAttribute("data-lit") ?? "";
      },
      { capture: true, once: true },
    );
  });
}

async function litAtPress(page: Page): Promise<string> {
  return (await page.evaluate(() => (window as unknown as { __litAtPress?: string }).__litAtPress ?? "")) as string;
}

/** Waits for the Stop button to be live on `page`, then presses it; returns what was lit when it was pressed. */
async function pressStop(pages: readonly Page[], page: Page): Promise<string> {
  await eventually(pages, async () => (await page.locator('.wx-srv-adv-stop[data-live="1"]').count()) > 0, "Stop is live");
  await armLitAtPress(page);
  await page.locator(".wx-srv-adv-stop").click();
  await eventually(pages, async () => (await litAtPress(page)) !== "", "the press was seen");
  return await litAtPress(page);
}

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 } as const;

/** Plays a round from the start to the chosen place, both screens in the tab. Returns the round's seq. */
async function playToChosen(
  a: Page,
  b: Page,
  options: { shots?: boolean } = {},
): Promise<{ seq: string; country: string; place: string }> {
  const pages = [a, b];
  const seq = await startAdventure(a);
  await expect(adv(a)).toBeVisible();
  // Bob is OFFERED the tab (a dot), and the main chat carries the card; he opens it from the card.
  await eventually(pages, async () => await b.locator(`.wx-srv-bubble-adv[data-message-seq="${seq}"]`).isVisible(), "Bob sees the card");
  await expect(b.locator(".wx-srv-tab-adventure .wx-srv-tab-dot")).toBeVisible();
  await b.locator(`.wx-srv-bubble-adv[data-message-seq="${seq}"]`).getByRole("button", { name: "Play", exact: true }).click();
  await expect(adv(b)).toBeVisible();
  await waitFact(pages, "phase", "idle");
  await expect(a.locator(".wx-srv-adv-hint")).toContainText("Swipe sideways to spin");
  if (options.shots === true) await shot(a, "01-idle");

  // Spin 1: Alice drags sideways. Bob sees her finger (a live swipe) and then the same spin.
  await flickGlobe(a, "lng", async () => {
    await eventually(pages, async () => (await fact(b, "remote")) === "1", "Bob sees Alice's finger");
    if (options.shots === true) await shot(b, "02-watcher-sees-trail");
  });
  await waitFact(pages, "state", "spin_lat");
  await waitFact(pages, "phase", "idle2", 30_000);

  // Spin 2: up/down. The landing is stored once, so both screens show the same one.
  await eventually(pages, async () => (await a.locator('.wx-srv-adv-stage[data-interactive="spin"]').count()) > 0, "Alice may spin again");
  await flickGlobe(a, "lat");
  await waitFact(pages, "state", "country", 30_000);
  await waitFactSet(pages, "landing-unit");
  expect(await fact(b, "landing-unit")).toBe(await fact(a, "landing-unit"));

  // The country roulette: Alice presses Stop on what she sees lit; both screens settle on exactly that.
  await waitFact(pages, "phase", "country", 40_000);
  await eventually(pages, async () => (await a.locator('.wx-srv-adv-stop[data-live="1"]').count()) > 0, "Stop is live (countries)");
  await a.waitForTimeout(400); // the Stop button's colour fades in
  if (options.shots === true) await shot(a, "03-country-roulette");
  const country = await pressStop(pages, a);
  expect(country).not.toBe("");
  await waitFact(pages, "country", country);
  await waitFact(pages, "state", "destination");

  // The destination roulette: Bob stops it.
  await waitFact(pages, "phase", "destination", 30_000);
  await eventually(pages, async () => (await b.locator('.wx-srv-adv-stop[data-live="1"]').count()) > 0, "Stop is live (places)");
  if (options.shots === true) await shot(b, "04-destination-roulette");
  const place = await pressStop(pages, b);
  expect(place).not.toBe("");
  await waitFact(pages, "place", place);
  await waitFact(pages, "state", "chosen");
  return { seq, country, place };
}

test.describe("Adventure Time", () => {
  test("two people play a whole adventure: swipes, landing, both Stops, the pack, the chat, the bank", async ({ browser }) => {
    const contextA = await newGameContext(browser);
    const contextB = await newGameContext(browser);
    const a = await contextA.newPage();
    const b = await contextB.newPage();
    const errors = [trackConsoleErrors(a), trackConsoleErrors(b)];
    await unlockServer(a, "Alice");
    await unlockServer(b, "Bob");
    const pages = [a, b];
    const stopAwake = keepAwake(pages);

    // The game is a tab of its own, the thread is out of the way.
    await expect(a.locator(".wx-srv-tabs")).toBeHidden();
    const { seq, place } = await playToChosen(a, b, { shots: true });
    await expect(a.locator(".wx-srv-tab-adventure")).toHaveClass(/wx-srv-tab-on/);
    await expect(a.locator(".wx-srv-thread-wrap")).toBeHidden();

    // The pack arrives from the fake cmd: "Preparing…" first (or already done), then the pack.
    await waitFact(pages, "pack-state", "ready", 60_000);
    for (const page of pages) {
      await expect(page.locator(".wx-srv-adv-pk-headline")).toHaveText(CANNED_HEADLINE);
      await expect(page.locator(".wx-srv-adv-pk-card").first()).toBeVisible();
    }
    // Links open in a new tab and never leak the opener; the explore toggle gives the map the room.
    const links = a.locator(".wx-srv-adv-pk a.wx-srv-adv-pk-link");
    expect(await links.count()).toBeGreaterThan(0);
    for (let i = 0; i < (await links.count()); i += 1) {
      await expect(links.nth(i)).toHaveAttribute("target", "_blank");
      expect(await links.nth(i).getAttribute("rel")).toContain("noopener");
    }

    // The pack's pictures: the server finds and fetches them (the fixture's fake web) and the pane lays
    // them out when they arrive. Every picture the pane loads is on THIS origin (the browser never contacts
    // a third-party image host from a private chat), each carries its credit, and a tap opens the viewer.
    const origin = new URL(a.url()).origin;
    const requestedExternally: string[] = [];
    a.on("request", (request) => {
      const url = new URL(request.url());
      if (url.protocol.startsWith("http") && url.origin !== origin) requestedExternally.push(request.url());
    });
    await eventually(pages, async () => (await a.locator(".wx-srv-adv-hero-slide img").count()) > 0, "the pack's photos arrive", 60_000);
    await eventually(pages, async () => (await a.locator(".wx-srv-adv-pic-pending").count()) === 0, "no placeholders left", 30_000);
    const sources = (await a.locator(".wx-srv-adv img").evaluateAll((els) => els.map((el) => (el as HTMLImageElement).src))).filter((src) => src !== ""); // (the viewer's image has no file until it opens)
    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) expect(new URL(src).origin, src).toBe(origin);
    expect(await a.locator(".wx-srv-adv-hero-slide img").first().evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await expect(a.locator(".wx-srv-adv-hero-credit").first()).toContainText("Photo:");
    await shot(a, "05-pack");
    await humanPause(a);
    await a.locator(".wx-srv-adv-hero-pic").first().click();
    await expect(a.locator(".wx-srv-adv-viewer")).toBeVisible();
    await expect(a.locator(".wx-srv-adv-viewer-credit")).toContainText("Photo:");
    await shot(a, "05b-photo-viewer");
    await humanPause(a);
    await a.locator(".wx-srv-adv-viewer-close").click();
    await expect(a.locator(".wx-srv-adv-viewer")).toBeHidden();
    await humanPause(a);

    // "Local food to try" (spec §4.3b): a photo-forward grid straight after the summary, before the places
    // to eat. Four dishes have a photo from the fake Wikipedia; Bifana has none and is a text tile.
    const dishes = a.locator(".wx-srv-adv-dishes");
    await expect(dishes.locator(".wx-srv-adv-pk-title")).toHaveText("Local food to try");
    await expect(dishes.locator(".wx-srv-adv-dish")).toHaveCount(5);
    await expect(a.locator(".wx-srv-adv-pk-summary + .wx-srv-adv-dishes")).toHaveCount(1);
    await expect(a.locator(".wx-srv-adv-pk-food .wx-srv-adv-pk-title")).toHaveText("Where to eat");
    expect(
      await a.evaluate(() => {
        const grid = document.querySelector(".wx-srv-adv-dishes")!;
        const food = document.querySelector(".wx-srv-adv-pk-food")!;
        return Boolean(grid.compareDocumentPosition(food) & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
    ).toBe(true);
    await eventually(pages, async () => (await dishes.locator(".wx-srv-adv-dish-frame img").count()) === 4, "four dish photos arrive", 30_000);
    // The photos load lazily as the grid scrolls into view: bring it to the top of the pack panel first.
    await dishes.scrollIntoViewIfNeeded();
    await a.evaluate(() => document.querySelector(".wx-srv-adv-dishes")?.scrollIntoView({ block: "start" }));
    for (const img of await dishes.locator(".wx-srv-adv-dish-frame img").all()) {
      await eventually(pages, async () => await img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0), "a dish photo loads", 15_000);
    }
    await expect(dishes.locator(".wx-srv-adv-dish").nth(0)).toContainText("Pastel de nata");
    await expect(dishes.locator(".wx-srv-adv-dish-nophoto")).toHaveCount(1);
    await expect(dishes.locator(".wx-srv-adv-dish-nophoto")).toContainText("Bifana");
    // The grid is two columns on this 390 px phone, and every photo is a square.
    const boxes = await dishes.locator(".wx-srv-adv-dish-frame").evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })));
    expect(boxes[1]!.y).toBeCloseTo(boxes[0]!.y, 0);
    expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.h - 1);
    expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x + boxes[0]!.w - 1);
    for (const b of boxes) expect(Math.abs(b.w - b.h)).toBeLessThan(1.5);
    // Two screenshots of the grid (the pack panel is a short scroller on a phone: a row is about one panel tall).
    await a.evaluate(() => {
      const host = document.querySelector<HTMLElement>(".wx-srv-adv-pk-host")!;
      const grid = document.querySelector<HTMLElement>(".wx-srv-adv-dishes")!;
      host.scrollTop += grid.getBoundingClientRect().top - host.getBoundingClientRect().top + 26; // past the title: row one, photos and names
    });
    await shot(a, "05c-food-grid");
    await a.evaluate(() => {
      const host = document.querySelector<HTMLElement>(".wx-srv-adv-pk-host")!;
      host.scrollTop += 210; // row two
    });
    await shot(a, "05c2-food-grid-more");
    await a.evaluate(() => {
      const host = document.querySelector<HTMLElement>(".wx-srv-adv-pk-host")!;
      host.scrollTop += 205; // row three: the dish with no photo is a text tile
    });
    await shot(a, "05c3-food-grid-text-tile");
    // A tap on a dish with a photo opens the viewer on it: the photo, its credit and the whole description.
    await humanPause(a);
    await dishes.locator(".wx-srv-adv-dish").nth(1).click();
    await expect(a.locator(".wx-srv-adv-viewer")).toBeVisible();
    await expect(a.locator(".wx-srv-adv-viewer-caption")).toHaveText("Caldo verde");
    await expect(a.locator(".wx-srv-adv-viewer-detail")).toHaveText("Kale and potato soup with a slice of chorizo.");
    await expect(a.locator(".wx-srv-adv-viewer-credit-line")).toContainText("Photo:");
    await expect(a.locator(".wx-srv-adv-viewer-count")).toHaveText("2 / 5");
    expect(await a.locator(".wx-srv-adv-viewer-img").evaluate((el) => new URL((el as HTMLImageElement).src).origin)).toBe(origin);
    expect(await a.locator(".wx-srv-adv-viewer-img").evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await shot(a, "05d-dish-viewer");
    // The next dishes in the same viewer: Bacalhau (a photo), Ginjinha, then Bifana, which has none: a tile.
    for (const [name, hasPhoto] of [["Bacalhau com natas", true], ["Ginjinha", true], ["Bifana", false]] as const) {
      await humanPause(a);
      await a.locator(".wx-srv-adv-viewer-next").click();
      await expect(a.locator(".wx-srv-adv-viewer-caption")).toHaveText(name);
      await expect(a.locator(".wx-srv-adv-viewer-img")).toBeVisible({ visible: hasPhoto });
      await expect(a.locator(".wx-srv-adv-viewer-tile")).toBeVisible({ visible: !hasPhoto });
    }
    await expect(a.locator(".wx-srv-adv-viewer-credit-line")).toHaveCount(0);
    await humanPause(a);
    await a.locator(".wx-srv-adv-viewer-close").click();
    await expect(a.locator(".wx-srv-adv-viewer")).toBeHidden();
    expect(requestedExternally).toEqual([]);
    await humanPause(a);

    // The destination has its own mini chat (the shared one): a message lands in the other mini chat,
    // the pop-up shows the history with the one composer, and the main chat tags it "Adventure".
    async function say(page: Page, text: string): Promise<void> {
      await page.locator(".wx-chat-composer-input").fill(text);
      await page.locator(".wx-chat-send-button").click();
      await humanPause(page);
    }
    await say(a, "Imagine the custard tarts");
    await eventually(pages, async () => (await b.locator(".wx-srv-adv .wx-srv-game-mini").innerText()).includes("Imagine the custard tarts"), "Bob's mini chat");
    await expect(b.locator(".wx-srv-adv .wx-srv-game-mini")).toContainText("Alice:");
    await b.locator(".wx-srv-adv .wx-srv-game-mini-msg").first().click();
    await expect(b.locator(".wx-srv-gamepop")).toBeVisible();
    await expect(b.locator(".wx-srv-gamepop")).toContainText("Imagine the custard tarts");
    await expect(b.locator(".wx-srv-gamepop .wx-chat-composer-input")).toBeVisible();
    await say(b, "Book it");
    await eventually(pages, async () => (await a.locator(".wx-srv-adv .wx-srv-game-mini").innerText()).includes("Book it"), "Alice sees the reply");
    await b.locator(".wx-srv-gamepop-close").click();
    await expect(b.locator(".wx-srv-gamepop")).toBeHidden();

    // Back in the main chat: the card tells the story, the chat messages wear an "Adventure" tag.
    await a.locator(".wx-srv-tab-chat").click();
    await expect(a.locator(".wx-srv-thread-wrap")).toBeVisible();
    const card = a.locator(`.wx-srv-bubble-adv[data-message-seq="${seq}"]`);
    await expect(card.locator(".wx-srv-adv-mcard-status")).toContainText(CANNED_HEADLINE);
    await expect(a.locator('.wx-srv-bubble-gametag[data-game="adventure"]')).toHaveCount(2);
    // The card shows the first dish photo now that the pack has one (same origin, loaded) above the little map.
    const dishPhoto = card.locator("img.wx-srv-adv-mcard-dish");
    await expect(dishPhoto).toBeVisible();
    expect(await dishPhoto.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0 && new URL((el as HTMLImageElement).src).origin === location.origin)).toBe(true);
    await card.scrollIntoViewIfNeeded();
    await shot(a, "06-card-in-main-chat");

    // Bank it: both screens say so, and the trip is in the Holiday bank.
    await humanPause(a); // taps in quick succession lock the chat (R3): pause between the clicks
    await a.locator(".wx-srv-tab-adventure").click();
    await expect(a.locator(".wx-srv-adv-bank-this")).toBeVisible();
    await humanPause(a);
    await a.locator(".wx-srv-adv-bank-this").click();
    await waitFact(pages, "state", "banked");
    await expect(a.locator(".wx-srv-adv-outcome")).toContainText("Holiday bank");
    await humanPause(a);
    await a.locator(".wx-srv-tab-chat").click();
    await humanPause(a);
    await a.locator(".wx-srv-more-button").click();
    await expect(a.locator(".wx-srv-more-bank")).toBeVisible();
    await humanPause(a);
    await a.locator(".wx-srv-more-bank").click();
    await expect(a.locator(".wx-srv-bank-view")).toBeVisible();
    await expect(a.locator(".wx-srv-bank-trip")).toHaveCount(1);
    await expect(a.locator(".wx-srv-bank-trip-headline")).toContainText(CANNED_HEADLINE);
    expect(place).toMatch(/\./); // a bank destination id: "<unit>.<slug>"
    await shot(a, "07-holiday-bank");

    // A tap opens that trip in the Adventure tab, pack and chat.
    await humanPause(a);
    await a.locator(".wx-srv-bank-trip").first().click();
    await expect(a.locator(".wx-srv-bank-view")).toBeHidden();
    await expect(a.locator(".wx-srv-tab-adventure")).toHaveClass(/wx-srv-tab-on/);
    await waitFact([a], "state", "banked");
    await expect(a.locator(".wx-srv-adv-pk-headline")).toHaveText(CANNED_HEADLINE);
    await expect(a.locator(".wx-srv-adv .wx-srv-game-mini")).toContainText("Book it");

    for (const e of errors) expect(e.filter((m) => !/favicon/i.test(m))).toEqual([]);
    stopAwake();
    await closeAll(contextA, contextB);
  });

  test("No thanks asks once, 'Never show again' rejects the place for good", async ({ browser }) => {
    const contextA = await newGameContext(browser);
    const contextB = await newGameContext(browser);
    const a = await contextA.newPage();
    const b = await contextB.newPage();
    const errors = [trackConsoleErrors(a), trackConsoleErrors(b)];
    await unlockServer(a, "Alice");
    await unlockServer(b, "Bob");
    const pages = [a, b];
    const stopAwake = keepAwake(pages);
    const { place } = await playToChosen(a, b);

    // Bob passes: the question is asked once, "Keep it" backs out, "Never show again" confirms.
    await eventually(pages, async () => (await b.locator(".wx-srv-adv-pass").isVisible()), "the decision buttons");
    await b.locator(".wx-srv-adv-pass").click();
    await expect(b.locator(".wx-srv-adv-ask")).toContainText("again?");
    await expect(b.locator(".wx-srv-adv-never")).toBeVisible();
    await humanPause(b);
    await b.locator(".wx-srv-adv-keep").click();
    await expect(b.locator(".wx-srv-adv-bank-this")).toBeVisible();
    expect(await fact(b, "state")).toBe("chosen");
    await humanPause(b);
    await b.locator(".wx-srv-adv-pass").click();
    await humanPause(b);
    await b.locator(".wx-srv-adv-never").click();
    await waitFact(pages, "state", "rejected");
    await expect(a.locator(".wx-srv-adv-outcome")).toContainText("won't come up again");

    // (That the place never returns to the draws is the server's never-again list: pytest covers it.)
    // Play again starts a fresh adventure, which replaces the finished one (still just Chat + Adventure).
    await a.locator(".wx-srv-adv-again").click();
    await eventually(pages, async () => (await a.locator(".wx-srv-bubble-adv").count()) === 2, "a new adventure card");
    await expect(a.locator(".wx-srv-tab-game:visible")).toHaveCount(1);
    await waitFact([a], "state", "spin_lng");
    expect(place).not.toBe("");

    for (const e of errors) expect(e.filter((m) => !/favicon/i.test(m))).toEqual([]);
    stopAwake();
    await closeAll(contextA, contextB);
  });

  test("Adventure and Would-you-rather replace each other: the tab bar only ever holds two tabs", async ({ browser }) => {
    const context = await newGameContext(browser);
    const page = await context.newPage();
    const errors = trackConsoleErrors(page);
    await unlockServer(page, "Alice");

    async function startWyr(): Promise<void> {
      await page.locator(".wx-srv-more-button").click();
      await expect(page.locator(".wx-srv-more-wyr")).toBeVisible();
      await humanPause(page);
      await page.locator(".wx-srv-more-wyr").click();
      await humanPause(page);
    }

    await startAdventure(page);
    await expect(page.locator(".wx-srv-tab-adventure")).toHaveClass(/wx-srv-tab-on/);
    await expect(page.locator(".wx-srv-tab-game:visible")).toHaveCount(1);

    await startWyr(); // replaces the Adventure tab: Chat + WYR
    await expect(page.locator(".wx-srv-tab-wyr")).toHaveClass(/wx-srv-tab-on/);
    await expect(page.locator(".wx-srv-tab-adventure")).toBeHidden();
    await expect(page.locator(".wx-srv-tab:visible")).toHaveCount(2);
    await expect(adv(page)).toBeHidden();

    await startAdventure(page); // and back again
    await expect(page.locator(".wx-srv-tab-adventure")).toHaveClass(/wx-srv-tab-on/);
    await expect(page.locator(".wx-srv-tab-wyr")).toBeHidden();
    await expect(page.locator(".wx-srv-tab:visible")).toHaveCount(2);

    // The replaced game is not gone: its card in the main chat opens it again (and replaces this one).
    await humanPause(page);
    await page.locator(".wx-srv-tab-chat").click();
    await humanPause(page);
    await page.locator(".wx-srv-bubble-wyr").first().getByRole("button", { name: /Play|Open/ }).click();
    await expect(page.locator(".wx-srv-tab-wyr")).toHaveClass(/wx-srv-tab-on/);
    await expect(page.locator(".wx-srv-tab:visible")).toHaveCount(2);

    expect(errors.filter((m) => !/favicon/i.test(m))).toEqual([]);
    await context.close();
  });

  test("the Options switch for places the UK advises against is off by default and saved for both", async ({ browser }) => {
    const contextA = await newGameContext(browser);
    const contextB = await newGameContext(browser);
    const a = await contextA.newPage();
    const b = await contextB.newPage();
    await unlockServer(a, "Alice");
    await unlockServer(b, "Bob");
    await startAdventure(a);
    await expect(adv(a)).toBeVisible();

    await a.locator(".wx-srv-adv-options").click();
    await expect(a.locator(".wx-srv-adv-sheet")).toBeVisible();
    const advised = a.locator("#wx-srv-adv-opt-advised");
    await expect(advised).toBeEnabled();
    expect(await advised.isChecked()).toBe(false);
    await expect(a.locator(".wx-srv-adv-sheet")).toContainText("Include places the UK says not to travel to");
    await expect(a.locator(".wx-srv-adv-sheet")).toContainText("NASA Visible Earth");
    // The map style is per device and offered here too.
    await expect(a.locator(".wx-srv-adv-seg-button")).toHaveCount(3);
    await advised.evaluate((el) => (el as HTMLInputElement).click());
    await expect(advised).toBeEnabled();
    expect(await advised.isChecked()).toBe(true);
    await a.locator(".wx-srv-adv-sheet-close").click();
    await expect(a.locator(".wx-srv-adv-sheet")).toBeHidden();

    // The shared setting reaches Bob's sheet.
    await humanPause(b);
    await b.locator(".wx-srv-more-button").click();
    await humanPause(b);
    await b.locator(".wx-srv-more-adventure").click();
    await expect(adv(b)).toBeVisible();
    await b.locator(".wx-srv-adv-options").click();
    const bAdvised = b.locator("#wx-srv-adv-opt-advised");
    await expect(bAdvised).toBeEnabled();
    expect(await bAdvised.isChecked()).toBe(true);
    // Put it back (the fixture server is shared by this file's tests).
    await bAdvised.evaluate((el) => (el as HTMLInputElement).click());
    await expect(bAdvised).toBeEnabled();
    expect(await bAdvised.isChecked()).toBe(false);
    await closeAll(contextA, contextB);
  });

  test("the food grid fits a 360 px phone: two columns, square photos, nothing sideways, the viewer is on screen", async ({ browser }) => {
    // (A 360 px viewport, mouse input: the globe is flicked with the real mouse like in the other tests.)
    const small = { viewport: { width: 360, height: 780 }, deviceScaleFactor: 2 } as const;
    const contextA = await newGameContext(browser, small);
    const contextB = await newGameContext(browser);
    const a = await contextA.newPage();
    const b = await contextB.newPage();
    await unlockServer(a, "Alice");
    await unlockServer(b, "Bob");
    const pages = [a, b];
    const stopAwake = keepAwake(pages);
    await playToChosen(a, b);
    await waitFact(pages, "pack-state", "ready", 60_000);
    const dishes = a.locator(".wx-srv-adv-dishes");
    await expect(dishes.locator(".wx-srv-adv-dish")).toHaveCount(5);
    await eventually(pages, async () => (await dishes.locator(".wx-srv-adv-dish-frame img").count()) === 4, "dish photos", 30_000);
    await dishes.scrollIntoViewIfNeeded();
    await a.evaluate(() => document.querySelector(".wx-srv-adv-dishes")?.scrollIntoView({ block: "start" }));
    await a.screenshot({ path: test.info().outputPath("phone-360-food-grid.png") });

    const frames = await dishes.locator(".wx-srv-adv-dish-frame").evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })));
    expect(frames[1]!.y).toBeCloseTo(frames[0]!.y, 0); // two to a row
    expect(frames[2]!.x).toBeCloseTo(frames[0]!.x, 0);
    for (const f of frames) {
      expect(Math.abs(f.w - f.h)).toBeLessThan(1.5);
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w).toBeLessThanOrEqual(360.5);
    }
    expect(frames[0]!.w).toBeGreaterThan(120); // a real photo, not a thumbnail
    // Nothing overflows sideways, in the page or in the pack panel; the tiles are proper tap targets.
    expect(await a.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    const host = await a.locator(".wx-srv-adv-pk-host").evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(host.scroll).toBeLessThanOrEqual(host.client + 1);
    for (const tile of await dishes.locator(".wx-srv-adv-dish").all()) {
      const box = (await tile.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(43.5);
      expect(box.x + box.width).toBeLessThanOrEqual(360.5);
    }
    // A long description does not push the viewer's controls off the phone.
    await humanPause(a);
    await dishes.locator(".wx-srv-adv-dish").nth(0).click();
    await expect(a.locator(".wx-srv-adv-viewer")).toBeVisible();
    for (const selector of [".wx-srv-adv-viewer-close", ".wx-srv-adv-viewer-next", ".wx-srv-adv-viewer-detail", ".wx-srv-adv-viewer-credit"]) {
      const box = (await a.locator(selector).boundingBox())!;
      expect(box, selector).not.toBeNull();
      expect(box.x, `${selector} left`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${selector} right`).toBeLessThanOrEqual(360.5);
      expect(box.y + box.height, `${selector} bottom`).toBeLessThanOrEqual(780.5);
    }
    await a.screenshot({ path: test.info().outputPath("phone-360-dish-viewer.png") });
    stopAwake();
    await closeAll(contextA, contextB);
  });

  test("the game fits a 360 px phone with real tap targets", async ({ browser }) => {
    const context = await newGameContext(browser, { viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await unlockServer(page, "Alice");
    await startAdventure(page);
    await expect(adv(page)).toBeVisible();
    await waitFact([page], "phase", "idle");
    await page.screenshot({ path: test.info().outputPath("phone-360-idle.png") });

    // Nothing overflows sideways.
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(pageOverflow).toBeLessThanOrEqual(1);
    const paneFit = await adv(page).evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(paneFit.scroll).toBeLessThanOrEqual(paneFit.client + 1);

    // The globe keeps real room; the header, the mini chat, the composer and the tab bar are all on
    // screen, inside the width, and proper tap targets.
    const stage = (await page.locator(".wx-srv-adv-stage").boundingBox())!;
    expect(stage.height).toBeGreaterThanOrEqual(200);
    expect(stage.x).toBeGreaterThanOrEqual(0);
    expect(stage.x + stage.width).toBeLessThanOrEqual(360.5);
    for (const selector of [".wx-srv-adv-bar", ".wx-srv-adv .wx-srv-game-mini", ".wx-chat-composer-input", ".wx-srv-tab-chat", ".wx-srv-tab-adventure"]) {
      const box = (await page.locator(selector).first().boundingBox())!;
      expect(box, selector).not.toBeNull();
      expect(box.y + box.height, `${selector} bottom`).toBeLessThanOrEqual(780.5);
      expect(box.x, `${selector} left`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${selector} right`).toBeLessThanOrEqual(360.5);
    }
    for (const selector of [".wx-srv-adv-options", ".wx-srv-adv-bank", ".wx-srv-adv-new", ".wx-srv-adv-close"]) {
      const box = (await page.locator(selector).boundingBox())!;
      expect(box.x + box.width, `${selector} right`).toBeLessThanOrEqual(360.5);
      expect(box.height, `${selector} height`).toBeGreaterThanOrEqual(33.5);
    }
    // The header chips do not overlap each other.
    const rects = await page.locator(".wx-srv-adv-bar-actions > button").evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }),
    );
    for (let i = 1; i < rects.length; i += 1) expect(rects[i]!.left).toBeGreaterThanOrEqual(rects[i - 1]!.right - 0.5);
    await context.close();
  });

  test("on a desktop window the pane is tidy and the title sits beside its buttons", async ({ browser }) => {
    const context = await newGameContext(browser, { viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await unlockServer(page, "Alice");
    await startAdventure(page);
    await expect(adv(page)).toBeVisible();
    await waitFact([page], "phase", "idle");
    const stage = (await page.locator(".wx-srv-adv-stage").boundingBox())!;
    expect(stage.height).toBeGreaterThanOrEqual(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath("desktop-idle.png") });
    await context.close();
  });
});
