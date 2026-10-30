// E2E for the picture-first Cookout table (workspace 00058, spec/server-chat/09b-cookout-visual.md section F.3).
//
// The fixture server serves a real picture pack of placeholders (one tiny valid WebP per manifest sha, in a
// temp dir it reads as WIXY_COOKOUT_IMAGES_DIR) and a catalogue covering every bank id, so every card has a
// picture and a "what" line. Two parts:
//
//  1. The FIT MATRIX: five viewports (360x640, 390x844, 360x560, 360x480, 1280x800), each phone also with the
//     34 px bottom inset (injected as `.wx-srv-tabs { padding-bottom: 34px !important }`, exactly how the frame
//     applies the real one) and with a ringing call (the chat header is then really shown), for Open and Blind
//     rounds, with no twists and with every start-sheet twist on, always with the worst-case text (the bank's
//     longest name, 36 characters, plus a 60-character "what"). In every picking state each combination is
//     audited by `auditTable` in the page itself:
//       P >= 411 (P = the game pane's own height): nothing scrolls (the page, and every element in the pane
//       whatever its overflow, bar the two picture <img>s), every required part sits inside the viewport and
//       inside every clipping ancestor and is hit-testable, every target is 44x44 and none overlap, pictures
//       are at least 96x96 and names are not clamped;
//       P < 411: the page does not scroll, only the stage scrolls, and the fixed rows pass the same tests.
//  2. The behaviours: the intro, one tap picks, pictures load, the chef's carousel advances, the reveal grid
//     of ten with an emoji tile for a picture the pack lacks, and the Blind DOM carrying nothing of the
//     partner's picks.
//
// Nothing waits on a fixed sleep: layout is read after two animation frames and re-read until it is stable.

import { expect, test } from "../fixtures";
import type { BrowserContext, Page } from "@playwright/test";
import { trackConsoleErrors } from "./helpers";
import { unlockTogether } from "./two-devices";
import {
  closeAll,
  dismissIntro,
  eventually,
  game,
  humanPause,
  joinCookout,
  keepAwake,
  pickable,
  startCookout,
  startCookoutWithTwists,
  unlockServer,
  whoseTurn,
} from "./cookout-helpers";

// A ringing call needs the synthetic microphone Chromium offers (the same flags server-calls.spec.ts uses).
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } });
test.use({ actionTimeout: 30_000 }); // a click on a hidden element fails with its name at 30 s, not at the 5-minute test timeout
test.describe.configure({ timeout: 300_000 });

/** The bank's longest name (36 characters) and a 60-character "what": the worst case for the card text. */
const LONG_NAME = "Frozen puff pastry vol-au-vent bites";
const LONG_WHAT = "Small, crisp cases of buttery puff pastry, ready to fill up.";

interface Variant {
  readonly width: number;
  readonly height: number;
  readonly inset: number;
  readonly call: boolean;
  /** With `call`: the call has been answered (Mute and End shown) instead of ringing. */
  readonly answered?: boolean;
  /** The wide-font stress: every glyph is stretched (see `WIDE_FONT_CSS`), as a wider system font would. */
  readonly wide?: boolean;
}

/** A deterministic stand-in for a wider system font. CI renders with a Linux font roughly 20 % wider than the one a
 * Windows box has (measured: the skip label's scrollWidth 237 against 197 px), so the layout must also hold with
 * wider text. A wide-face family plus extra letter-spacing widens text on every platform, whichever fonts it has. */
const WIDE_FONT_CSS =
  '.wx-srv-ck, .wx-srv-ck * { font-family: Verdana, "DejaVu Sans", "Liberation Sans", sans-serif !important; letter-spacing: 0.005em !important; }';

const PHONES: ReadonlyArray<readonly [number, number]> = [
  [360, 640],
  [390, 844],
  [360, 560],
  [360, 480],
];

/** The whole matrix of one state: every viewport, each phone with the inset and with a ringing call. */
const VARIANTS: readonly Variant[] = [
  ...PHONES.flatMap(([width, height]) => [
    { width, height, inset: 0, call: false },
    { width, height, inset: 34, call: false },
  ]),
  { width: 1280, height: 800, inset: 0, call: false },
  ...PHONES.flatMap(([width, height]) => [
    { width, height, inset: 0, call: true },
    { width, height, inset: 34, call: true },
  ]),
  ...PHONES.flatMap(([width, height]) => [
    { width, height, inset: 0, call: true, answered: true },
    { width, height, inset: 34, call: true, answered: true },
  ]),
  // The wide-font stress, on every viewport with no call and each phone with the inset too.
  ...PHONES.flatMap(([width, height]) => [
    { width, height, inset: 0, call: false, wide: true },
    { width, height, inset: 34, call: false, wide: true },
  ]),
  { width: 1280, height: 800, inset: 0, call: false, wide: true },
];

type Expect = "cards" | "cloche" | "none";

interface AuditArgs {
  readonly expect: Expect;
  readonly call: boolean;
  /** The Skip button / Twists button are expected (the viewer is the one picking / a twist is usable). */
  readonly skip: boolean;
  readonly twists: boolean;
  /** The call has been answered: its Mute and End controls must be there too (F.3), not only Accept/Decline. */
  readonly answered?: boolean;
}

interface AuditResult {
  readonly pane: number;
  readonly failures: string[];
}

/** Runs the whole F.3 fit audit inside the page and returns every violation as a sentence. */
async function auditTable(page: Page, args: AuditArgs): Promise<AuditResult> {
  return await page.evaluate((a: AuditArgs): AuditResult => {
    const failures: string[] = [];
    const pane = document.querySelector<HTMLElement>('.wx-srv-ck[data-game="cookout"]');
    if (pane === null) return { pane: 0, failures: ["the Cookout pane is not there"] };
    const P = pane.getBoundingClientRect().height;
    const COMPACT = P < 508;
    const STAGE_SCROLLS = P < 411;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const label = (el: Element): string => {
      const aria = el.getAttribute("aria-label");
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 28);
      return `${el.className.toString().replace(/wx-srv-ck-?/g, "").split(" ")[0] ?? ""}${aria !== null ? ` [${aria.slice(0, 24)}]` : text !== "" ? ` "${text}"` : ""}`;
    };
    const boxes: Array<{ name: string; r: DOMRect }> = [];

    /** Whole inside the viewport and inside every clipping ancestor, and nothing on top at its centre. */
    const visible = (el: Element | null, name: string): DOMRect | null => {
      if (el === null) {
        failures.push(`${name}: missing`);
        return null;
      }
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) {
        failures.push(`${name}: has no box`);
        return null;
      }
      if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) {
        failures.push(`${name}: outside the viewport (${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)})`);
      }
      for (let up = el.parentElement; up !== null && up !== document.documentElement; up = up.parentElement) {
        const cs = getComputedStyle(up);
        if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
        const u = up.getBoundingClientRect();
        if (r.left < u.left - 0.5 || r.right > u.right + 0.5 || r.top < u.top - 0.5 || r.bottom > u.bottom + 0.5) {
          failures.push(`${name}: clipped by ${label(up)}`);
          break;
        }
      }
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (at === null || !(el === at || el.contains(at))) failures.push(`${name}: covered by ${at === null ? "nothing" : label(at)}`);
      return r;
    };

    /** An interactive target: seen, at least 44x44, and (later) not overlapping another. */
    const target = (el: Element | null, name: string, floor = 43.5): void => {
      const r = visible(el, name);
      if (r === null) return;
      if (r.width < floor || r.height < floor) failures.push(`${name}: target is ${Math.round(r.width)}x${Math.round(r.height)}, under the ${Math.round(floor + 0.5)}px floor`);
      boxes.push({ name, r });
    };

    // -- The page itself never scrolls ----------------------------------------------------------------------------
    const root = document.scrollingElement;
    if (root !== null && root.scrollHeight > vh + 1) failures.push(`the page scrolls (${root.scrollHeight} > ${vh})`);
    if (root !== null && root.scrollWidth > vw + 1) failures.push(`the page scrolls sideways (${root.scrollWidth} > ${vw})`);

    // -- Every element in the pane, whatever its overflow --------------------------------------------------------
    const stage = pane.querySelector<HTMLElement>(".wx-srv-ck-table-stage");
    for (const node of pane.querySelectorAll<HTMLElement>("*")) {
      // Exempt (F.3: "except the picture <img>s' own boxes"): the <img>s, the card picture's tile that holds one
      // (its img is cropped to fill it), and the style wheel, a fixed-height window (22 px) over a long reel of
      // faces (408 px) that overflows by construction.
      if (node.tagName === "IMG" || node.matches(".wx-srv-ck-card-pic, .wx-srv-ck-card-pic .wx-srv-ck-pic, .wx-srv-ck-wheel, .wx-srv-ck-wheel *") || node.getClientRects().length === 0) continue;
      if (node.clientHeight === 0 && node.clientWidth === 0) continue; // inline boxes have no scroll box
      if (STAGE_SCROLLS && node === stage) continue; // the one thing that may scroll, below 411
      if (STAGE_SCROLLS && stage !== null && stage.contains(node)) continue;
      if (node.scrollHeight > node.clientHeight + 1) failures.push(`${label(node)} overflows vertically (${node.scrollHeight} > ${node.clientHeight})`);
      if (node.scrollWidth > node.clientWidth + 1) failures.push(`${label(node)} overflows sideways (${node.scrollWidth} > ${node.clientWidth})`);
    }
    if (STAGE_SCROLLS && stage !== null) {
      const cs = getComputedStyle(stage);
      if (stage.scrollHeight > stage.clientHeight + 1 && cs.overflowY !== "auto" && cs.overflowY !== "scroll") {
        failures.push(`the stage overflows but its overflow-y is ${cs.overflowY}`);
      }
    }

    // -- The title row, banner, progress, actions, chat button and call controls -------------------------------------
    visible(pane.querySelector(".wx-srv-ck-title"), "title row");
    for (const button of pane.querySelectorAll<HTMLElement>(".wx-srv-ck-bar-actions button")) {
      if (button.getClientRects().length > 0) target(button, `title control ${label(button)}`);
    }
    const banner = pane.querySelector(".wx-srv-ck-banner");
    visible(banner, "turn banner");
    if (banner !== null && (banner.textContent ?? "").trim() === "") failures.push("turn banner: has no text");
    target(pane.querySelector(".wx-srv-ck-progress"), "progress button");
    if (a.skip) target(pane.querySelector(".wx-srv-ck-skip"), "skip button");
    if (a.twists) target(pane.querySelector(".wx-srv-ck-twists-btn"), "Twists button");
    // The chat button lives in the shared frame, in the reserved chat row.
    target(pane.querySelector(".wx-srv-float-fab"), "chat button");
    if (a.call) {
      const live = [...document.querySelectorAll<HTMLElement>(".wx-srv-call button")].filter((b) => b.getClientRects().length > 0);
      if (live.length === 0) {
        const widget = document.querySelector(".wx-srv-call");
        const notice = [...document.querySelectorAll(".wx-srv-call-notice")].map((n) => (n.textContent ?? "").trim()).join(" / ");
        failures.push(`a call is live but its controls are not shown (call state "${widget?.getAttribute("data-state") ?? "none"}", notice "${notice}")`);
      }
      // 44x44 with no exception (09b F.3).
      if (a.answered === true) {
        const names = live.map((b) => `${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`.toLowerCase());
        if (!names.some((n) => n.includes("mute"))) failures.push("an answered call shows no Mute control");
        if (!names.some((n) => /(^|\s)end(\s|$)/.test(n))) failures.push(`an answered call shows no End control (shown: ${names.join(" | ")})`);
      }
      for (const control of live) target(control, `call control ${label(control)}`);
    }

    // -- The two cards (or the cloche) ---------------------------------------------------------------------------
    const cards = [...pane.querySelectorAll<HTMLElement>(".wx-srv-ck-pair .wx-srv-ck-card")];
    if (a.expect === "cards") {
      if (cards.length !== 2) failures.push(`expected 2 cards, found ${cards.length}`);
      if (pane.querySelector(".wx-srv-ck-cloche") !== null) failures.push("a cloche stands where the pair should be");
    } else if (a.expect === "none") {
      if (cards.length !== 0) failures.push(`no pair is due yet but ${cards.length} cards are in the DOM`);
    } else {
      if (cards.length !== 0) failures.push(`the cloche is up but ${cards.length} cards are in the DOM`);
      // Below P=411 the cloche stands in the scrolling stage, which may clip it: it only has to exist there.
      if (STAGE_SCROLLS) {
        if (pane.querySelector(".wx-srv-ck-cloche") === null) failures.push("cloche: missing");
      } else visible(pane.querySelector(".wx-srv-ck-cloche"), "cloche");
    }
    for (const [i, card] of cards.entries()) {
      const name = `card ${i + 1}`;
      if (STAGE_SCROLLS) continue; // below 411 the cards live in the scrolling stage and are not all on screen
      visible(card, name);
      if (card.tagName === "BUTTON" && card.getAttribute("disabled") === null) target(card, name);
      const pic = card.querySelector<HTMLElement>(".wx-srv-ck-card-pic");
      const picBox = visible(pic, `${name} picture`);
      if (picBox !== null && (picBox.width < 95.5 || picBox.height < 95.5)) {
        failures.push(`${name} picture is ${Math.round(picBox.width)}x${Math.round(picBox.height)}, under 96x96`);
      }
      const nameEl = card.querySelector<HTMLElement>(".wx-srv-ck-card-name");
      visible(nameEl, `${name} name`);
      if (nameEl !== null) {
        if (nameEl.scrollHeight > nameEl.clientHeight + 1) failures.push(`${name} name is clamped (${nameEl.scrollHeight} > ${nameEl.clientHeight})`);
        if (getComputedStyle(nameEl).textOverflow === "ellipsis") failures.push(`${name} name has an ellipsis`);
      }
      const what = card.querySelector<HTMLElement>(".wx-srv-ck-card-what");
      if (!COMPACT) {
        visible(what, `${name} what-line`);
        if (what !== null && what.scrollHeight > what.clientHeight + 1) failures.push(`${name} what-line is clamped`);
      }
    }

    // -- No two targets overlap -------------------------------------------------------------------------------------
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const x = boxes[i]!;
        const y = boxes[j]!;
        const w = Math.min(x.r.right, y.r.right) - Math.max(x.r.left, y.r.left);
        const h = Math.min(x.r.bottom, y.r.bottom) - Math.max(x.r.top, y.r.top);
        if (w > 1 && h > 1) failures.push(`${x.name} and ${y.name} overlap`);
      }
    }
    return { pane: P, failures };
  }, args);
}

/** Puts a page at one matrix variant: viewport, the 34 px inset, and two animation frames to settle. */
async function applyLayout(page: Page, v: Variant): Promise<void> {
  await page.setViewportSize({ width: v.width, height: v.height });
  await page.evaluate(
    ([css, on]: [string, boolean]) => {
      let style = document.getElementById("e2e-wide");
      if (style === null) {
        style = document.createElement("style");
        style.id = "e2e-wide";
        document.head.append(style);
      }
      style.textContent = on ? css : "";
    },
    [WIDE_FONT_CSS, v.wide === true] as [string, boolean],
  );
  await page.evaluate((px: number) => {
    let style = document.getElementById("e2e-inset");
    if (style === null) {
      style = document.createElement("style");
      style.id = "e2e-inset";
      document.head.append(style);
    }
    style.textContent = px > 0 ? `.wx-srv-tabs { padding-bottom: ${px}px !important }` : "";
  }, v.inset);
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

/** Every worst-case view: both options of the pair carry the longest name and a 60-character "what". */
async function useLongText(page: Page): Promise<void> {
  await page.route(/\/api\/admin\/server\/cookout\/\d+\?as=/, async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as { current?: { options?: Array<Record<string, unknown>> | null } | null };
    const options = json.current?.options;
    if (Array.isArray(options)) {
      for (const option of options) {
        option["name"] = LONG_NAME;
        option["what"] = LONG_WHAT;
      }
    }
    await route.fulfill({ response, json });
  });
}

/** The call connection of a page can close on a loaded box (the widget then says "Calls disconnected" and offers
 * "Reconnect calls", which a person taps). Do what the person would, so a ring starts from two connected devices. */
async function reconnectCallsIfClosed(page: Page): Promise<void> {
  const reconnect = page.locator(".wx-srv-call").getByRole("button", { name: "Reconnect calls" });
  if (await reconnect.isVisible()) {
    await humanPause(page);
    await reconnect.click();
    await expect(reconnect).toBeHidden({ timeout: 15_000 });
    await humanPause(page); // the next tap must be 400 ms away, or the chat locks (R3)
  }
}

/** Rings `measured` from `other` (the second device calls the first) and returns a hang-up. One retry:
 * a call started in the instant after the previous one ended can be dropped by the call broker. */
async function ring(
  measured: Page,
  other: Page,
  measuredName: string,
): Promise<{ answer: () => Promise<void>; end: () => Promise<void>; decline: () => Promise<void> }> {
  const chatTab = other.locator(".wx-srv-tab-chat");
  const wasInGame = await game(other).isVisible();
  if (await chatTab.isVisible()) {
    await chatTab.click();
    await humanPause(other);
  }
  const callPanel = other.locator(".wx-srv-call");
  await reconnectCallsIfClosed(other);
  await reconnectCallsIfClosed(measured);
  const attempt = async (): Promise<boolean> => {
    const callButton = callPanel.getByRole("button", { name: "Call", exact: true });
    try {
      // The Call button is disabled while the other device is not in this device's peer list, which is exactly
      // what a device whose call connection closed ("Calls disconnected", the 6 s no-message watchdog) looks like
      // from the other side. Either device may be the one that dropped, so each poll reconnects whichever shows it.
      await expect(async () => {
        await reconnectCallsIfClosed(other);
        await reconnectCallsIfClosed(measured);
        await expect(callButton).toBeEnabled({ timeout: 1_000 });
      }).toPass({ timeout: 30_000 });
    } catch (error) {
      const state = async (page: Page): Promise<string> =>
        await page.locator(".wx-srv-call").evaluate((el) => `${el.getAttribute("data-state")} | ${(el.textContent ?? "").replace(/\s+/g, " ").trim()}`).catch(() => "no call widget");
      throw new Error(`the second device cannot start a call: its Call button stays disabled. second device: ${await state(other)}; ringing device: ${await state(measured)}`, { cause: error });
    }
    await humanPause(other); // two taps under 400 ms apart lock the chat (R3)
    await callButton.click({ timeout: 10_000 });
    await humanPause(other);
    await other.getByRole("radio", { name: new RegExp(measuredName) }).check({ timeout: 10_000 });
    await humanPause(other);
    await other.getByRole("button", { name: "Confirm call", exact: true }).click({ timeout: 10_000 });
    try {
      await expect(measured.locator(".wx-srv-call")).toContainText("Incoming call", { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  };
  if (!(await attempt())) {
    const cancel = callPanel.getByRole("button", { name: "Cancel call" });
    if (await cancel.isVisible()) await cancel.click();
    await humanPause(other);
    expect(await attempt(), "the measured device is ringing").toBe(true);
  }
  const idle = async (): Promise<void> => {
    await expect(measured.locator(".wx-srv-call")).toHaveAttribute("data-state", "idle");
    await expect(callPanel).toHaveAttribute("data-state", "idle");
    await expect(callPanel.getByRole("button", { name: "Call", exact: true })).toBeEnabled();
    // Back to where the second device was: its game tab.
    const gameTab = other.locator(".wx-srv-tab-cookout");
    if (wasInGame && (await gameTab.isVisible())) {
      await humanPause(other);
      await gameTab.click();
      await expect(game(other)).toBeVisible();
    }
  };
  const live = measured.locator(".wx-srv-call");
  return {
    answer: async () => {
      await humanPause(measured);
      await live.getByRole("button", { name: "Answer", exact: true }).click();
      await expect(live.getByRole("button", { name: /mute/i })).toBeVisible({ timeout: 15_000 });
    },
    end: async () => {
      await live.getByRole("button", { name: /^end/i }).first().click();
      await idle();
    },
    decline: async () => {
      await live.getByRole("button", { name: "Decline", exact: true }).click();
      await idle();
    },
  };
}

interface Rig {
  readonly contextA: BrowserContext;
  readonly contextB: BrowserContext;
  readonly pageA: Page;
  readonly pageB: Page;
  readonly stop: () => void;
  readonly errors: Array<() => string[]>;
}

async function rig(browser: import("@playwright/test").Browser, long: boolean): Promise<Rig> {
  const options = { viewport: { width: 390, height: 844 }, permissions: ["microphone" as const] };
  const contextA = await browser.newContext(options);
  const contextB = await browser.newContext(options);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const errors = [trackConsoleErrors(pageA), trackConsoleErrors(pageB)];
  if (long) {
    await useLongText(pageA);
    await useLongText(pageB);
  }
  const stop = await unlockTogether(unlockServer, [[pageA, "Alice"], [pageB, "Bob"]]);
  return { contextA, contextB, pageA, pageB, stop, errors: errors.map((e) => () => e.filter((m) => !/favicon|getUserMedia|microphone/i.test(m))) };
}

/** The call controller ends a live call, on purpose, when the page cannot keep up: the main thread stalls longer than
 * `LEASE_MS` (300 ms, admin-ui/src/server/call/protocol.ts) or the socket backs up for more than 250 ms ("The browser
 * paused, so the call stopped" / "The connection couldn't keep up, so the call stopped"). On a box running several
 * suites that happens now and then to a call held across many layout checks, and its notice then sits over the banner.
 * That drop is the product's safety behaviour, not a layout fault, so the answered-call variants recognise exactly it
 * (by the notice's words), dismiss the notice and set the call up again; any other failure still fails. */
const CALL_DROPPED = /couldn't keep up|browser paused|call stopped/i;

async function droppedCallNotice(page: Page): Promise<string | null> {
  const text = (await page.locator(".wx-srv-call-notice").allInnerTexts()).join(" / ");
  return CALL_DROPPED.test(text) ? text : null;
}

async function dismissCallNotice(page: Page): Promise<void> {
  const dismiss = page.locator(".wx-srv-call").getByRole("button", { name: "Dismiss call details" });
  if (await dismiss.isVisible()) {
    await dismiss.click();
    await humanPause(page); // the next tap must be 400 ms away, or the chat locks (R3)
  }
}

/** Audits one page in one state across the whole matrix; a ringing call is set up once for its variants. */
/** Puts a page back on the game tab if it had been showing the game: a call moves a device to the Chat tab, and the
 * next step's click would otherwise wait on a pane that is not shown. */
async function backToGame(page: Page, wasInGame: boolean): Promise<void> {
  if (!wasInGame || (await game(page).isVisible())) return;
  const tab = page.locator(".wx-srv-tab-cookout");
  if (await tab.isVisible()) {
    await humanPause(page);
    await tab.click();
  }
  await expect(game(page)).toBeVisible({ timeout: 15_000 });
}

async function sweep(measured: Page, other: Page, measuredName: string, state: string, args: Omit<AuditArgs, "call">): Promise<number> {
  let audits = 0;
  const measuredWasInGame = await game(measured).isVisible();
  const otherWasInGame = await game(other).isVisible();
  await dismissCallNotice(measured);
  await dismissCallNotice(other);
  const run = async (v: Variant): Promise<void> => {
    await applyLayout(measured, v);
    const where = `${state} @ ${v.width}x${v.height} inset ${v.inset}${v.call ? (v.answered === true ? " + answered call" : " + ringing call") : ""}${v.wide === true ? " + wide font" : ""}`;
    await expect
      .poll(async () => (await auditTable(measured, { ...args, call: v.call, answered: v.answered })).failures, { message: where, timeout: 4_000 })
      .toEqual([]);
    audits += 1;
  };
  for (const v of VARIANTS.filter((x) => !x.call && x.wide !== true)) await run(v);
  for (const v of VARIANTS.filter((x) => x.wide === true)) await run(v);
  let call = await ring(measured, other, measuredName);
  for (const v of VARIANTS.filter((x) => x.call && x.answered !== true)) await run(v);
  await call.answer();
  let drops = 0;
  for (const v of VARIANTS.filter((x) => x.answered === true)) {
    for (;;) {
      try {
        await run(v);
        break;
      } catch (error) {
        const notice = await droppedCallNotice(measured);
        if (notice === null || drops >= 3) throw error; // only the call controller's own watchdog is tolerated
        drops += 1;
        test.info().annotations.push({ type: "call-watchdog-drop", description: `${state}: ${notice}` });
        await dismissCallNotice(measured);
        await dismissCallNotice(other);
        call = await ring(measured, other, measuredName);
        await call.answer();
      }
    }
  }
  // A call that was dropped after its last check has already ended; ending a call that is over is not a failure.
  if ((await droppedCallNotice(measured)) === null) await call.end();
  else {
    await dismissCallNotice(measured);
    await dismissCallNotice(other);
  }
  await backToGame(measured, measuredWasInGame);
  await backToGame(other, otherWasInGame);
  await applyLayout(measured, { width: 390, height: 844, inset: 0, call: false });
  return audits;
}

/** Plays a round far enough to reach every picking state in `states`, auditing each. */
async function playMatrix(browser: import("@playwright/test").Browser, blind: boolean, withTwists: boolean): Promise<void> {
  const r = await rig(browser, true);
  const { pageA, pageB } = r;
  let audited = 0;
  const open = !blind;
  try {
    // "Every twist on" = every start-sheet twist that is part of the picking table: a spun style, the one-pan
    // challenge, the cloche, secret stars and the fridge raid (their five icons fill the Twists strip, and the
    // fridge raid's starter shows in the basket). The leftovers ENCORE is the sixth start-sheet twist and is left
    // out on purpose: it can only be started from a dish of an EARLIER finished round that left an ingredient out,
    // and it changes only which ingredients are seated as starters, which the fridge raid already puts on the
    // table (server-cookout-twists.spec.ts plays the encore end to end). The drafting twists (Lucky dip, Chaos
    // shelf, Sweep one) are in the Twists sheet and are exercised below in every round.
    const seq = withTwists
      ? await startCookoutWithTwists(pageA, blind, { style: "spin", challenge: "one-pan", cloche: true, stars: true, fridge: "rice" })
      : (await startCookout(pageA, blind), await pageA.locator(".wx-srv-bubble-ck").last().getAttribute("data-message-seq"))!;

    if (!withTwists) await expect(game(pageA).locator(".wx-srv-ck-pair .wx-srv-ck-card")).toHaveCount(2);
    if (withTwists) await expect(game(pageA).locator(".wx-srv-ck-strip")).toBeVisible();
    // State: the starter, before the partner has joined ("waiting for Join").
    // With the fridge raid on, turn 1 is the starter's own pick, so no pair is due until the partner joins.
    audited += await sweep(pageA, pageB, "Alice", "before the partner joins", { expect: withTwists ? "none" : "cards", skip: !withTwists, twists: false });
    await joinCookout(pageB, seq);

    // The fridge-raid twist makes the starter's first turn a starter pick; find whose pair is up.
    const first = await whoseTurn([pageA, pageB]);
    const mine = first.page;
    const mineName = first.index === 0 ? "Alice" : "Bob";
    const theirs = first.index === 0 ? pageB : pageA;
    const theirName = first.index === 0 ? "Bob" : "Alice";

    const twistsButton = (page: Page) => game(page).locator("button.wx-srv-ck-twists-btn");

    // State: my turn (normal pair, skip and Twists available), and the partner watching (Open: the same pair,
    // not tappable, with the Sweep twist in its Twists sheet) or the cloche (Blind: nothing of the pair).
    audited += await sweep(mine, theirs, mineName, "my turn", { expect: "cards", skip: true, twists: true });
    audited += await sweep(theirs, mine, theirName, open ? "watching the partner's turn" : "Blind cloche", {
      expect: open ? "cards" : "cloche",
      skip: false,
      twists: open,
    });

    if (open) {
      // State: a swept pair. The watcher sweeps one card off the picker's table (Twists sheet -> Sweep one -> tap);
      // the picker's banner carries the note and the table stays whole. Blind has no watcher view of the pair.
      await humanPause(theirs);
      await twistsButton(theirs).click();
      const sweepItem = game(theirs).locator(".wx-srv-ck-twist-item.wx-srv-ck-sweep");
      await expect(sweepItem, "the watcher can sweep one").toBeEnabled();
      await sweepItem.click();
      await humanPause(theirs);
      await game(theirs).locator(".wx-srv-ck-pair button.wx-srv-ck-card").first().click();
      await expect(game(mine).locator(".wx-srv-ck-turn-sub"), "the veto note was reached").toContainText(/swept/i, { timeout: 20_000 });
      audited += await sweep(mine, theirs, mineName, "a pair with a swept ingredient (the veto note)", { expect: "cards", skip: true, twists: true });
    }

    // State: the Twists sheet opened and closed again leaves the table exactly as it was.
    await humanPause(mine);
    await twistsButton(mine).click();
    await expect(game(mine).locator('.wx-srv-ck-sheet[data-sheet="twists"]')).toBeVisible();
    await humanPause(mine);
    await game(mine).locator(".wx-srv-ck-sheet-close").click();
    await expect(game(mine).locator(".wx-srv-ck-sheet")).toBeHidden();
    audited += await sweep(mine, theirs, mineName, "the Twists sheet closed again", { expect: "cards", skip: true, twists: true });

    // State: the final pair (both skips used; the Skip button is the disabled "Final pair").
    const skip = game(mine).locator(".wx-srv-ck-skip");
    for (const label of [/\(1 left\)/, /Final pair/]) {
      await humanPause(mine);
      await skip.click();
      await expect(skip).toHaveText(label, { timeout: 20_000 });
    }
    audited += await sweep(mine, theirs, mineName, "the final pair", { expect: "cards", skip: true, twists: true });

    // State: the chaos pair (the picker's Twists sheet -> Chaos shelf; Open: the watcher sees it too).
    await humanPause(mine);
    await twistsButton(mine).click();
    const chaos = game(mine).locator(".wx-srv-ck-twist-item.wx-srv-ck-chaos");
    await expect(chaos, "the picker can use the chaos shelf").toBeEnabled();
    await chaos.click();
    await expect(game(mine).locator(".wx-srv-ck-pair-chaos"), "the chaos pair was reached").toHaveCount(1, { timeout: 20_000 });
    audited += await sweep(mine, theirs, mineName, "the chaos pair", { expect: "cards", skip: false, twists: true });
    if (open) {
      // The watcher's one sweep went on the swept pair above, so no Twists button is shown to it now.
      await expect(game(theirs).locator(".wx-srv-ck-pair-chaos")).toHaveCount(1, { timeout: 20_000 });
      await expect(twistsButton(theirs)).toHaveCount(0);
      audited += await sweep(theirs, mine, theirName, "watching the chaos pair", { expect: "cards", skip: false, twists: false });
    }
    expect(audited, "audits run").toBeGreaterThan(40);
    for (const read of r.errors) expect(read()).toEqual([]);
  } finally {
    r.stop();
    await closeAll(r.contextA, r.contextB);
  }
}

test.describe("Cookout picture-first table: the fit matrix", () => {
  test.describe.configure({ mode: "parallel" });
  test("Open round, no twists", async ({ browser }) => {
    await playMatrix(browser, false, false);
  });
  test("Open round, every twist on", async ({ browser }) => {
    await playMatrix(browser, false, true);
  });
  test("Blind round, no twists", async ({ browser }) => {
    await playMatrix(browser, true, false);
  });
  test("Blind round, every twist on", async ({ browser }) => {
    await playMatrix(browser, true, true);
  });
});

// -- The behaviours -------------------------------------------------------------------------------------------------

/** Plays ten alternating picks (first card each time); returns the ids picked. */
async function pickTen(pages: readonly [Page, Page]): Promise<string[]> {
  const ids: string[] = [];
  for (let turn = 1; turn <= 10; turn += 1) {
    const { page } = await whoseTurn(pages);
    const card = pickable(page).first();
    const id = (await card.getAttribute("data-ingredient")) ?? "";
    await humanPause(page);
    await card.click();
    ids.push(id);
    await eventually(pages, async () => (await pickable(pages[0]).count()) !== 2 || (await pickable(pages[1]).count()) !== 2 || turn === 10, `pick ${turn} lands`);
  }
  return ids;
}

test.describe("Cookout picture-first table: behaviours", () => {
  test("the intro shows once, dismisses and does not come back after a reload", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = trackConsoleErrors(page);
    await unlockServer(page, "Alice");
    const stop = keepAwake([page]);
    await startCookout(page, false, false);
    const intro = game(page).locator(".wx-srv-ck-intro:not([hidden])");
    await expect(intro).toBeVisible();
    await expect(intro.locator(".wx-srv-ck-intro-go")).toHaveText(/cook/i);
    await dismissIntro(page);
    await expect(intro).toHaveCount(0);
    await page.reload();
    await unlockServer(page, "Alice");
    await page.locator(".wx-srv-bubble-ck .wx-srv-ck-mcard-open").last().click();
    await expect(game(page)).toBeVisible();
    await expect(pickable(page)).toHaveCount(2);
    await expect(game(page).locator(".wx-srv-ck-intro:not([hidden])")).toHaveCount(0);
    stop();
    expect(errors.filter((m) => !/favicon/i.test(m))).toEqual([]);
    await context.close();
  });

  test("one tap on a picture card picks; the pictures really load; the progress thumb appears", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = trackConsoleErrors(page);
    await unlockServer(page, "Alice");
    const stop = keepAwake([page]);
    await startCookout(page, false);
    const cards = pickable(page);
    await expect(cards).toHaveCount(2);
    // Every card shows a picture the server really serves: an <img> with a decoded width.
    const images = game(page).locator(".wx-srv-ck-pair .wx-srv-ck-card img");
    await expect(images).toHaveCount(2);
    await expect.poll(async () => await images.evaluateAll((els) => els.map((e) => (e as HTMLImageElement).naturalWidth > 0))).toEqual([true, true]);
    await expect.poll(async () => await images.evaluateAll((els) => els.map((e) => (e as HTMLImageElement).currentSrc.includes("/admin/cookout-img/")))).toEqual([true, true]);
    const progress = game(page).locator("button.wx-srv-ck-progress");
    const filledBefore = await progress.locator(".wx-srv-ck-prog-full").count();
    const picked = (await cards.first().getAttribute("data-ingredient"))!;
    await humanPause(page);
    await cards.first().click();
    await expect(game(page).locator(`.wx-srv-ck-table-stage [data-ingredient="${picked}"]`)).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () => await progress.locator(".wx-srv-ck-prog-full").count()).toBeGreaterThan(filledBefore);
    stop();
    expect(errors.filter((m) => !/favicon/i.test(m))).toEqual([]);
    await context.close();
  });

  test("the chef's carousel shows while the dishes are made, advances, and goes when they arrive", async ({ browser }) => {
    const r = await rig(browser, false);
    const { pageA, pageB } = r;
    try {
      // Hold the chef for a while so the carousel can be watched, then let it finish.
      await pageA.request.post("/test/cookout/chef-delay", { data: { seconds: 20 } });
      const seq = (await startCookout(pageA, false), (await pageA.locator(".wx-srv-bubble-ck").last().getAttribute("data-message-seq"))!);
      await joinCookout(pageB, seq);
      await pickTen([pageA, pageB]);
      const carousel = game(pageA).locator(".wx-srv-ck-car");
      await expect(carousel).toBeVisible({ timeout: 30_000 });
      const dot = (): Promise<number> => carousel.locator(".wx-srv-ck-car-dot").evaluateAll((els) => els.findIndex((e) => e.classList.contains("wx-srv-ck-car-dot-on")));
      // A pointer resting on the carousel holds it (by design): park the mouse outside it.
      await pageA.mouse.move(1, 1);
      const start = await dot();
      await expect.poll(dot, { message: "the carousel moves on by itself", timeout: 25_000 }).not.toBe(start);
      const slides = carousel.locator(".wx-srv-ck-car-slide");
      expect(await slides.count()).toBeGreaterThanOrEqual(10);
      await expect(carousel.locator(".wx-srv-ck-car-slide img").first()).toHaveJSProperty("complete", true);
      await pageA.request.post("/test/cookout/chef-delay", { data: { seconds: 2 } });
      await expect(game(pageA).locator(".wx-srv-ck-dish").first()).toBeVisible({ timeout: 60_000 });
      await expect(carousel).toHaveCount(0);
    } finally {
      await pageA.request.post("/test/cookout/chef-delay", { data: { seconds: 2 } });
      r.stop();
      await closeAll(r.contextA, r.contextB);
    }
  });

  test("the reveal shows ten pictures, and an emoji tile where the pack lacks one", async ({ browser }) => {
    const r = await rig(browser, false);
    const { pageA, pageB } = r;
    try {
      await pageA.request.post("/test/cookout/chef-delay", { data: { seconds: 20 } });
      const seq = (await startCookout(pageA, false), (await pageA.locator(".wx-srv-bubble-ck").last().getAttribute("data-message-seq"))!);
      await joinCookout(pageB, seq);
      const ids = await pickTen([pageA, pageB]);
      // The pack loses one picked ingredient's files: its tile falls back to the emoji.
      const lost = ids[0]!;
      expect((await (await pageA.request.post("/test/cookout/drop-picture", { data: { id: lost } })).json()) as { dropped: boolean }).toEqual({ dropped: true });
      const reveal = game(pageA).locator(".wx-srv-ck-reveal");
      await expect(reveal).toBeVisible({ timeout: 30_000 });
      const tiles = reveal.locator(".wx-srv-ck-reveal-grid .wx-srv-ck-rtile");
      await expect(tiles).toHaveCount(10);
      await expect(tiles.locator("img")).toHaveCount(9);
      await expect(reveal.locator(".wx-srv-ck-pic-fallback .wx-srv-ck-pic-emoji")).toHaveCount(1);
      // Lazy pictures load as they scroll into view: bring each one up, then every one has decoded.
      for (const img of await tiles.locator("img").all()) await img.scrollIntoViewIfNeeded();
      await expect.poll(async () => await tiles.locator("img").evaluateAll((els) => els.every((e) => (e as HTMLImageElement).naturalWidth > 0))).toBe(true);
    } finally {
      await pageA.request.post("/test/cookout/chef-delay", { data: { seconds: 2 } });
      r.stop();
      await closeAll(r.contextA, r.contextB);
    }
  });

  test("Blind: the partner's names and picture URLs are not in the DOM until the reveal", async ({ browser }) => {
    const r = await rig(browser, false);
    const { pageA, pageB } = r;
    try {
      const seq = (await startCookout(pageA, true), (await pageA.locator(".wx-srv-bubble-ck").last().getAttribute("data-message-seq"))!);
      await joinCookout(pageB, seq);
      const first = await whoseTurn([pageA, pageB]);
      const watcher = first.index === 0 ? pageB : pageA;
      const picker = first.page;
      // What the picker is offered: its names and picture URLs, which the watcher must never hold.
      const offered = await picker.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".wx-srv-ck-pair .wx-srv-ck-card")].map((card) => ({
          id: card.getAttribute("data-ingredient") ?? "",
          name: card.querySelector(".wx-srv-ck-card-name")?.textContent ?? "",
          srcs: [...card.querySelectorAll("img")].map((img) => img.getAttribute("src") ?? ""),
        })),
      );
      expect(offered).toHaveLength(2);
      await expect(game(watcher).locator(".wx-srv-ck-cloche")).toBeVisible();
      const html = await watcher.evaluate(() => document.documentElement.outerHTML);
      // What the watcher can SEE or hear: the rendered text plus every attribute a screen reader or tooltip uses.
      // A name is matched as whole words (a short name such as "Cep" is also inside "concept", which proves nothing).
      const shown = await watcher.evaluate(() => {
        const attrs = ["alt", "aria-label", "title", "placeholder", "value"];
        const parts = [document.body.innerText];
        for (const el of document.querySelectorAll("*")) for (const a of attrs) parts.push(el.getAttribute(a) ?? "");
        return parts.join(" | ");
      });
      const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const item of offered) {
        expect(html, `the watcher's DOM holds ${item.id}`).not.toContain(`data-ingredient="${item.id}"`);
        expect(shown, `the watcher's DOM shows ${item.name}`).not.toMatch(
          new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(item.name)}($|[^\\p{L}\\p{N}])`, "iu"),
        );
        for (const src of item.srcs) expect(html, "a picture URL of the partner's pair").not.toContain(src);
      }
    } finally {
      r.stop();
      await closeAll(r.contextA, r.contextB);
    }
  });
});
