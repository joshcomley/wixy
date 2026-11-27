// E2E for the PUBLIC, no-login Adventure Time (workspace 00065, spec/adventure-public/README.md §4 item 6,
// docs/ai/adventure-public.md): one person plays the whole globe game alone, on a desktop and on a 360 px
// phone, against the fixture server whose researcher is the fake cmd (the canned pack after ~2 s).
//
// HOST. The game is served by the SAME wixy process, host-gated: the fixture sets
// WIXY_ADVENTURE_PUBLIC_HOST=localhost (fixture_server.py `PUBLIC_HOST`). Every other spec reaches the
// server as `127.0.0.1:<port>` (fixtures.ts's baseURL), a different Host for the gate, so none of them
// changes; this spec reaches the SAME port as `localhost:<port>` for the public game. Chromium resolves
// `localhost` to loopback by itself (no resolver rule, no launch argument).
//
// ORIGIN. The page is plain http here but the server only starts research for a POST whose `Origin` is the
// production `https://<host>`; the browser would send `http://localhost:<port>`. `publicContext` therefore
// sends that one request on from the runner with the right header (a Playwright route), so the real check stays on and the
// page behaves as it does at https://adventure.cinnamons.uk. A wrong Origin is still a 403 (its own test).
//
// The globe is a canvas, so the tests read the pane's `data-*` facts (`data-state`, `data-phase`, `data-lit`,
// `data-country`, `data-place`, `data-pack-state`), exactly as server-adventure.spec.ts does, and spin it with
// the same in-page pointer events that carry their own timestamps (a flick that cannot be slowed by a loaded
// runner). The bank, the never-again list and the setting live in `localStorage` (`advPublic.v1.*`).

import { expect, test } from "../fixtures";
import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";
import { trackConsoleErrors } from "./helpers";

test.describe.configure({ timeout: 240_000 });

/** fixture_server.py `PUBLIC_HOST`: the host name the public game is served on. */
const PUBLIC_HOST = "localhost";
/** What the browser would send as `Origin` at the real address (the server's `shell.origin`). */
const PRODUCTION_ORIGIN = `https://${PUBLIC_HOST}`;
/** The canned pack the fake cmd researcher returns (wixy_server/tests/fake_cmd.py `CANNED_ADVENTURE_PACK`). */
const CANNED_HEADLINE = "Sun, tiles and custard tarts on the Atlantic edge of Europe";
const BANKED_KEY = "advPublic.v1.banked";
const REJECTED_KEY = "advPublic.v1.rejected";
const MISSING_TEXT = "That place isn't on the map any more";

interface BankDest {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}
interface BankUnit {
  readonly id: string;
  readonly advised: boolean;
  readonly destinations: readonly BankDest[];
}

const VIEWPORTS = [
  { name: "desktop", viewport: { width: 1280, height: 800 } },
  { name: "mobile 360 px", viewport: { width: 360, height: 780 } },
] as const;

/** The public game's own origin for this worker's server: the same port, the public host name. */
function publicOrigin(baseURL: string | undefined): string {
  const url = new URL(baseURL ?? "");
  url.hostname = PUBLIC_HOST;
  return url.origin;
}

interface PublicContext {
  readonly context: BrowserContext;
  readonly requests: string[];
}

/**
 * A fresh browser context that plays the public game: its own (empty) localStorage, clipboard access, the
 * flat Classic map (quick to draw on a software-GL runner) and the production `Origin` on research starts.
 * `requests` collects the URL of every request the context makes.
 */
async function publicContext(browser: Browser, viewport: { width: number; height: number }): Promise<PublicContext> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, permissions: ["clipboard-read", "clipboard-write"] });
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("wixy.adventure.mapStyle", "classic");
    } catch {
      // storage blocked: the default style it is
    }
  });
  await context.route("**/api/pack/*", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    // `continue({headers})` cannot change Origin (the browser owns it); a fetch made by the test runner can.
    await route.fulfill({ response: await route.fetch({ headers: { ...request.headers(), origin: PRODUCTION_ORIGIN } }) });
  });
  const requests: string[] = [];
  context.on("request", (request) => requests.push(request.url()));
  return { context, requests };
}

/** Closes a context from `publicContext`. A pack request the page still has in flight is answered by the route
 * above, which would otherwise fail ("Request context disposed") inside whichever test runs next. */
async function closePublicContext(context: BrowserContext): Promise<void> {
  await context.unrouteAll({ behavior: "ignoreErrors" });
  await context.close();
}

function adv(page: Page): ReturnType<Page["locator"]> {
  return page.locator(".wx-srv-adv");
}

async function fact(page: Page, name: string): Promise<string> {
  return (await adv(page).getAttribute(`data-${name}`)) ?? "";
}

/** Polls `check` until it holds. A key press counts as a touch of activity and never disturbs a drag. */
async function eventually(page: Page, check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await page.waitForTimeout(120);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

async function waitFact(page: Page, name: string, value: string, timeoutMs = 20_000): Promise<void> {
  await eventually(page, async () => (await fact(page, name)) === value, `data-${name}=${value}`, timeoutMs);
}

async function waitFactAnyOf(page: Page, name: string, values: readonly string[], timeoutMs = 20_000): Promise<void> {
  await eventually(page, async () => values.includes(await fact(page, name)), `data-${name} in ${values.join("|")}`, timeoutMs);
}

async function waitFactSet(page: Page, name: string, timeoutMs = 20_000): Promise<void> {
  await eventually(page, async () => (await fact(page, name)) !== "", `data-${name} set`, timeoutMs);
}

/** A drag on the globe: a slow part, then a quick flick and the release (see server-adventure.spec.ts
 * `dragGlobe`: in-page pointer events with EXPLICIT timestamps, never `page.mouse`, whose late events turn a
 * flick into a slow swipe on a loaded machine). */
async function dragGlobe(page: Page, axis: "lng" | "lat"): Promise<void> {
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
}

/** A flick that MUST turn into a spin, first time: no retry (one would only hide a real defect). */
async function flickGlobe(page: Page, axis: "lng" | "lat"): Promise<void> {
  await dragGlobe(page, axis);
  const deadline = Date.now() + 10_000;
  let phase = "";
  while (Date.now() < deadline) {
    phase = await fact(page, "phase");
    if (phase === "spin1" || phase === "spin2") return;
    await page.waitForTimeout(60);
  }
  throw new Error(`the ${axis} flick never turned into a spin (phase stayed "${phase}")`);
}

/** Waits for the Stop button to be live, presses it, and returns which item was lit the instant it was pressed. */
async function pressStop(page: Page): Promise<string> {
  await eventually(page, async () => (await page.locator('.wx-srv-adv-stop[data-live="1"]').count()) > 0, "Stop is live");
  await page.evaluate(() => {
    const w = window as unknown as { __litAtPress?: string };
    w.__litAtPress = undefined;
    const stop = document.querySelector(".wx-srv-adv-stop");
    const pane = document.querySelector(".wx-srv-adv");
    stop?.addEventListener("pointerdown", () => { w.__litAtPress = pane?.getAttribute("data-lit") ?? ""; }, { capture: true, once: true });
  });
  await page.locator(".wx-srv-adv-stop").click();
  await eventually(page, async () => (await page.evaluate(() => (window as unknown as { __litAtPress?: string }).__litAtPress)) !== undefined, "the press was seen");
  return (await page.evaluate(() => (window as unknown as { __litAtPress?: string }).__litAtPress ?? "")) as string;
}

/** Waits for the page to have loaded the bank and shown its first screen (a fresh round, or a place). */
async function waitForGame(page: Page): Promise<void> {
  await expect(adv(page)).toBeVisible({ timeout: 30_000 });
  await waitFactSet(page, "state", 30_000);
}

/** Plays a fresh round from the first spin to the chosen place: both spins, the country Stop, the place Stop. */
async function playToChosen(page: Page): Promise<{ country: string; place: string }> {
  await waitFact(page, "phase", "idle", 30_000);
  await expect(page.locator(".wx-srv-adv-hint")).toContainText("Swipe sideways to spin");
  await flickGlobe(page, "lng");
  await waitFact(page, "state", "spin_lat");
  await waitFact(page, "phase", "idle2", 30_000);
  await eventually(page, async () => (await page.locator('.wx-srv-adv-stage[data-interactive="spin"]').count()) > 0, "the globe may be spun again");
  await flickGlobe(page, "lat");
  await waitFact(page, "state", "country", 30_000);
  await waitFactSet(page, "landing-unit");
  await waitFact(page, "phase", "country", 40_000);
  const country = await pressStop(page);
  expect(country).not.toBe("");
  await waitFact(page, "country", country);
  // A country with exactly ONE place left skips the place roulette: the round goes straight to `chosen`.
  await waitFactAnyOf(page, "state", ["destination", "chosen"]);
  if ((await fact(page, "state")) === "destination") {
    await waitFact(page, "phase", "destination", 30_000);
    const place = await pressStop(page);
    expect(place).not.toBe("");
    await waitFact(page, "place", place);
  }
  await waitFact(page, "state", "chosen");
  const place = await fact(page, "place");
  expect(place).not.toBe("");
  return { country, place };
}

async function loadBank(page: Page): Promise<BankUnit[]> {
  return await page.evaluate(async () => {
    const response = await fetch("/api/bank", { credentials: "same-origin" });
    const json = (await response.json()) as { countries: Record<string, { advice: unknown; destinations: { id: string; code: string; name: string }[] }> };
    return Object.entries(json.countries).map(([id, unit]) => ({
      id,
      advised: unit.advice !== null && unit.advice !== undefined,
      destinations: unit.destinations.map((d) => ({ id: d.id, code: d.code, name: d.name })),
    }));
  });
}

function nameOf(units: readonly BankUnit[], id: string): string {
  for (const unit of units) for (const dest of unit.destinations) if (dest.id === id) return dest.name;
  throw new Error(`no destination ${id} in the public bank`);
}

async function stored(page: Page, key: string): Promise<unknown> {
  return await page.evaluate((k) => {
    const raw = window.localStorage.getItem(k);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  }, key);
}

async function publicRuns(request: APIRequestContext, baseURL: string | undefined): Promise<number> {
  const response = await request.post(`${baseURL}/test/adventure-public/runs`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { runs: number }).runs;
}

/** The page has no sideways scroll (nothing wider than the viewport). */
async function expectNoOverflow(page: Page, what: string): Promise<void> {
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth, inner: window.innerWidth }));
  expect(widths.scroll, `${what}: document wider than the viewport`).toBeLessThanOrEqual(widths.inner);
  expect(widths.body, `${what}: body wider than the viewport`).toBeLessThanOrEqual(widths.inner);
}

/** Every request this context made went to the public origin (data: and blob: URLs are not requests to anyone). */
function expectOnlyPublicOrigin(requests: readonly string[], origin: string): void {
  const outside = requests.filter((url) => {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin !== origin;
  });
  expect(outside, "requests that left the public origin").toEqual([]);
}

for (const { name, viewport } of VIEWPORTS) {
  test.describe(`public Adventure Time, ${name}`, () => {
    test("a whole round: spins, landing, both Stops, the pack, Yay banks it, the bank survives a reload, Copy link opens from the cache", async ({ browser, baseURL, request }) => {
      const origin = publicOrigin(baseURL);
      const { context, requests } = await publicContext(browser, viewport);
      const page = await context.newPage();
      const errors = trackConsoleErrors(page);

      // The home page loads with no login: the game, the footer, the title.
      const response = await page.goto(`${origin}/`);
      expect(response?.status()).toBe(200);
      await waitForGame(page);
      await expect(page).toHaveTitle("Adventure Time");
      await expect(page.locator(".adv-pub-footer")).toContainText("Holiday packs are written by AI");
      await expect(page.locator(".wx-srv-adv-pass")).toBeHidden(); // nothing chosen yet: no Yay / Nay
      await expectNoOverflow(page, "home");

      const units = await loadBank(page);
      const runsBefore = await publicRuns(request, baseURL);
      const { place } = await playToChosen(page);
      const placeName = nameOf(units, place);
      const dest = units.flatMap((u) => u.destinations).find((d) => d.id === place)!;

      // The place has its short link in the address bar and its name in the title.
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/d/${dest.code}`);
      await expect(page).toHaveTitle(`${placeName} · Adventure Time`);

      // The pack is researched by the fake cmd and arrives (text only here: no picture finder is wired).
      await waitFact(page, "pack-state", "ready", 60_000);
      await expect(page.locator(".wx-srv-adv-pk-headline")).toHaveText(CANNED_HEADLINE);
      await expect(page.locator(".wx-srv-adv-pk-card").first()).toBeVisible();
      const links = page.locator(".wx-srv-adv-pk a.wx-srv-adv-pk-link");
      for (let i = 0; i < (await links.count()); i += 1) {
        await expect(links.nth(i)).toHaveAttribute("target", "_blank");
        const rel = (await links.nth(i).getAttribute("rel")) ?? "";
        expect(rel).toContain("noopener");
        expect(rel).toContain("nofollow");
      }
      await expectNoOverflow(page, "pack");
      const runsAfterFirst = await publicRuns(request, baseURL);
      expect(runsAfterFirst - runsBefore, "one research run for a place nobody had researched").toBeLessThanOrEqual(1);

      // Yay banks it: the browser's own storage holds the trip, and it is in the Holiday bank.
      await page.locator(".wx-srv-adv-bank-this").click();
      await waitFact(page, "state", "banked");
      const banked = (await stored(page, BANKED_KEY)) as { destinationId: string; code: string }[];
      expect(banked.map((e) => e.destinationId)).toEqual([place]);
      expect(banked[0]!.code).toBe(dest.code);
      await page.locator(".wx-srv-adv-bank").click();
      await expect(page.locator(".wx-srv-bank-view")).toBeVisible();
      await expect(page.locator(".wx-srv-bank-trip")).toHaveCount(1);
      await expect(page.locator(".wx-srv-bank-trip-name")).toHaveText(placeName);
      await expectNoOverflow(page, "holiday bank");

      // A reload keeps the bank (localStorage): the trip is still listed, and its place opens at once.
      await page.reload();
      await waitForGame(page);
      expect((await stored(page, BANKED_KEY)) as unknown[]).toHaveLength(1);
      await page.locator(".wx-srv-adv-bank").click();
      await expect(page.locator(".wx-srv-bank-trip")).toHaveCount(1);
      await expect(page.locator(".wx-srv-bank-trip-name")).toHaveText(placeName);
      await page.locator(".wx-srv-bank-trip").first().click();
      await expect(page.locator(".wx-srv-bank-view")).toBeHidden();
      await waitFact(page, "state", "chosen");
      await waitFact(page, "place", place);

      // Copy link: the short link at the production address, on the clipboard.
      await page.locator(".wx-srv-adv-copylink").click();
      await expect(page.locator(".wx-srv-adv-toast")).toContainText("Link copied");
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toMatch(new RegExp(`^${PRODUCTION_ORIGIN.replace(/[.]/g, "\\.")}/d/[a-z0-9]{6}$`));
      expect(copied).toBe(`${PRODUCTION_ORIGIN}/d/${dest.code}`);
      await waitFact(page, "pack-state", "ready", 30_000); // opened from the bank: served from the cache

      // Opened in a FRESH browser (new context, nothing stored): the place is there at once with its pack, from
      // the shared cache, so no second research run is made for it.
      const fresh = await publicContext(browser, viewport);
      const freshPage = await fresh.context.newPage();
      const freshErrors = trackConsoleErrors(freshPage);
      const linkResponse = await freshPage.goto(`${origin}${new URL(copied).pathname}`);
      expect(linkResponse?.status()).toBe(200);
      await waitForGame(freshPage);
      await waitFact(freshPage, "state", "chosen", 30_000);
      await waitFact(freshPage, "place", place, 30_000);
      await expect(freshPage).toHaveTitle(`${placeName} · Adventure Time`);
      await waitFact(freshPage, "pack-state", "ready", 20_000);
      await expect(freshPage.locator(".wx-srv-adv-pk-headline")).toHaveText(CANNED_HEADLINE);
      await expect(freshPage.locator(".wx-srv-adv-copylink")).toBeVisible();
      await expectNoOverflow(freshPage, "shared link");
      await freshPage.waitForTimeout(1_500); // a research start, if one were going to happen, would have happened
      expect(await publicRuns(request, baseURL), "the shared link must not research the place again").toBe(runsAfterFirst);
      // That browser knows nothing of the first one's bank.
      await freshPage.locator(".wx-srv-adv-bank").click();
      await expect(freshPage.locator(".wx-srv-bank-trip")).toHaveCount(0);
      await expect(freshPage.locator(".wx-srv-bank-empty")).toBeVisible();

      // Nothing in either browser reached outside the public origin.
      expectOnlyPublicOrigin(requests, origin);
      expectOnlyPublicOrigin(fresh.requests, origin);
      for (const list of [errors, freshErrors]) expect(list.filter((m) => !/favicon/i.test(m))).toEqual([]);
      await closePublicContext(fresh.context);
      await closePublicContext(context);
    });

    test("Nay asks first, 'Never show again' keeps the place out of every later draw, and a reload keeps that", async ({ browser, baseURL }) => {
      const origin = publicOrigin(baseURL);
      const { context, requests } = await publicContext(browser, viewport);
      const page = await context.newPage();
      const errors = trackConsoleErrors(page);
      await page.goto(`${origin}/`);
      await waitForGame(page);
      const units = await loadBank(page);

      // Two places of one playable country: P (which is turned down) and S (the only other one left in play).
      const unit = units.find((u) => !u.advised && u.destinations.length >= 2)!;
      const [p, s] = [unit.destinations[0]!, unit.destinations[1]!];

      // Open P by its link (a place shown at once), then Nay: the question is asked, "Keep it" backs out.
      await page.goto(`${origin}/d/${p.code}`);
      await waitForGame(page);
      await waitFact(page, "place", p.id, 30_000);
      await waitFact(page, "state", "chosen");
      await expect(page.locator(".wx-srv-adv-bank-this")).toHaveText("Yay");
      await expect(page.locator(".wx-srv-adv-pass")).toHaveText("Nay");
      await expectNoOverflow(page, "place with Yay / Nay");
      await page.locator(".wx-srv-adv-pass").click();
      await expect(page.locator(".wx-srv-adv-ask")).toContainText("again?");
      await page.locator(".wx-srv-adv-keep").click();
      await expect(page.locator(".wx-srv-adv-bank-this")).toBeVisible();
      expect(await fact(page, "state")).toBe("chosen");
      expect(await stored(page, REJECTED_KEY)).toBeNull(); // asking changed nothing
      await page.locator(".wx-srv-adv-pass").click();
      await page.locator(".wx-srv-adv-never").click();
      await waitFact(page, "state", "rejected");
      await expect(page.locator(".wx-srv-adv-outcome")).toContainText("won't come up again");
      expect(await stored(page, REJECTED_KEY)).toEqual([p.id]);
      expect(await stored(page, BANKED_KEY)).toBeNull();

      // The list is the browser's: it survives a reload (and the Holiday bank has nothing in it).
      await page.reload();
      await waitForGame(page);
      expect(await stored(page, REJECTED_KEY)).toEqual([p.id]);
      await page.locator(".wx-srv-adv-bank").click();
      await expect(page.locator(".wx-srv-bank-empty")).toBeVisible();
      await page.locator(".wx-srv-bank-close").click();

      // Never drawn again. Put every place EXCEPT P and S on the never-again list too (P is on it only because the
      // button above put it there), so that the one country in play has exactly two places, one of them P. If P
      // were still drawable, the country Stop would offer both and go on to a place roulette; it must go straight
      // to S, the only place left.
      await page.evaluate(
        ({ key, keep }) => {
          // Read at call time: the page's own list (P) is the one that must hold P out.
          const own = JSON.parse(window.localStorage.getItem(key) ?? "[]") as string[];
          window.localStorage.setItem(key, JSON.stringify([...own, ...keep.out]));
        },
        { key: REJECTED_KEY, keep: { out: units.flatMap((u) => u.destinations.map((d) => d.id)).filter((id) => id !== p.id && id !== s.id) } },
      );
      await page.getByRole("button", { name: "Start a new adventure" }).click(); // (after the reload the place is shown again, so the Play again button is not up)
      await waitFact(page, "state", "spin_lng");
      expect(new URL(page.url()).pathname).toBe("/");
      const round = await playToChosen(page);
      expect(round.place).toBe(s.id);
      expect(round.country).toBe(unit.id);
      expect(await stored(page, REJECTED_KEY)).toContain(p.id);

      expectOnlyPublicOrigin(requests, origin);
      expect(errors.filter((m) => !/favicon/i.test(m))).toEqual([]);
      await closePublicContext(context);
    });

    test("a link to a place that is not on the map says so, and Spin the globe starts a game", async ({ browser, baseURL }) => {
      const origin = publicOrigin(baseURL);
      const { context, requests } = await publicContext(browser, viewport);
      const page = await context.newPage();
      const errors = trackConsoleErrors(page);
      const response = await page.goto(`${origin}/d/zzzzzz`);
      expect(response?.status()).toBe(404);
      await expect(page.locator(".adv-pub-missing-title")).toHaveText(MISSING_TEXT, { timeout: 30_000 });
      await expect(page.locator(".adv-pub-spin")).toBeVisible();
      await expectNoOverflow(page, "not on the map");
      await page.locator(".adv-pub-spin").click();
      await waitForGame(page);
      await waitFact(page, "state", "spin_lng");
      expect(new URL(page.url()).pathname).toBe("/");
      await expect(page.locator(".adv-pub-missing")).toBeHidden();
      expectOnlyPublicOrigin(requests, origin);
      expect(errors.filter((m) => !/favicon/i.test(m))).toEqual([]);
      await closePublicContext(context);
    });
  });
}

test.describe("the host gate", () => {
  const NOT_PUBLIC_PATHS = [
    "/admin",
    "/admin/",
    "/admin/edit/index",
    "/api/admin/server/state",
    "/api/admin/session",
    "/internal/ready",
    "/internal/warmup",
    "/healthz",
    "/api/version",
    "/index.html",
    "/about",
    "/test/server/config",
    "/d",
    "/d/",
    "/assets/../admin/index.html",
  ];

  test("on the public host every admin, internal and site path is a plain 404, and the public routes answer", async ({ request, baseURL }) => {
    const origin = publicOrigin(baseURL);
    for (const path of NOT_PUBLIC_PATHS) {
      const response = await request.get(`${origin}${path}`, { maxRedirects: 0 });
      expect(response.status(), `GET ${path} on the public host`).toBe(404);
      expect(response.headers()["x-robots-tag"], `GET ${path}`).toBe("noindex");
    }
    for (const path of ["/api/admin/server/state", "/test/server/config", "/internal/warmup"]) {
      const response = await request.post(`${origin}${path}`, { maxRedirects: 0 });
      expect(response.status(), `POST ${path} on the public host`).toBe(404);
    }

    // The public routes are there, with their headers.
    const shell = await request.get(`${origin}/`);
    expect(shell.status()).toBe(200);
    const html = await shell.text();
    expect(html).toContain("adventure-public-boot");
    expect(html).toContain("Adventure Time");
    expect(shell.headers()["x-robots-tag"]).toBe("noindex");
    expect(shell.headers()["content-security-policy"]).toContain("default-src 'self'");
    const bank = await request.get(`${origin}/api/bank`);
    expect(bank.status()).toBe(200);
    expect(Object.keys(((await bank.json()) as { countries: object }).countries).length).toBeGreaterThan(50);
    const robots = await request.get(`${origin}/robots.txt`);
    expect(robots.status()).toBe(200);
    expect(await robots.text()).toContain("Disallow: /");
    const unknown = await request.get(`${origin}/d/zzzzzz`);
    expect(unknown.status()).toBe(404);
    expect(await unknown.text()).toContain(MISSING_TEXT.replace("'", "&#x27;")); // (HTML-escaped in the shell)
    const noPack = await request.get(`${origin}/api/pack/zzzzzz`);
    expect(noPack.status()).toBe(404);
  });

  test("a research start must come from the public origin (a wrong Origin is a 403 and starts nothing)", async ({ request, baseURL }) => {
    const origin = publicOrigin(baseURL);
    const before = await publicRuns(request, baseURL);
    const bank = (await (await request.get(`${origin}/api/bank`)).json()) as { countries: Record<string, { destinations: { code: string }[] }> };
    const code = Object.values(bank.countries)[0]!.destinations[0]!.code;
    for (const headers of [{ origin }, { origin: "https://evil.example" }, {}]) {
      const response = await request.post(`${origin}/api/pack/${code}`, { headers });
      expect(response.status(), JSON.stringify(headers)).toBe(403);
    }
    expect(await publicRuns(request, baseURL)).toBe(before);
  });

  test("on the private host the public routes do not exist, and the site and the admin are as before", async ({ request, baseURL }) => {
    for (const path of ["/api/bank", "/api/pack/abcdef", "/d/abcdef", "/assets/app.js", "/media/0123456789abcdef0123456789abcdef/thumb.jpg"]) {
      const response = await request.get(`${baseURL}${path}`);
      expect(response.status(), `GET ${path} on the private host`).toBe(404);
    }
    const home = await request.get(`${baseURL}/`);
    expect(home.status()).toBe(200);
    expect(await home.text()).not.toContain("adventure-public-boot");
    expect(home.headers()["x-robots-tag"]).toBeUndefined();
    const admin = await request.get(`${baseURL}/admin`);
    expect(admin.status()).toBe(200);
  });
});
