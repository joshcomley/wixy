// Live-page layout measurement for the Server chat (visual-polish task).
// usage: node measure.mjs <label> [--seed] [--css file.css] [--widths 375,402,768,1280] [--extras]
// Runs against the e2e fixture server (WIXY_E2E_PORT, default 8811). Screenshots -> ./shots/<label>-<w>.png
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(here, "../../e2e/package.json"));
const { chromium } = require("@playwright/test");

const args = process.argv.slice(2);
const label = args[0] ?? "run";
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const PORT = process.env.WIXY_E2E_PORT ?? "8811";
const BASE = `http://127.0.0.1:${PORT}`;
const widths = opt("--widths", "375,402,768,1280").split(",").map(Number);
const cssFile = opt("--css", null);
const cssOverrideFile = opt("--cssOverride", null);
const extraCss = cssFile ? fs.readFileSync(path.resolve(cssFile), "utf8") : null;
const heights = { 375: 812, 402: 870, 768: 1024, 1280: 800 };
fs.mkdirSync(path.join(here, "shots"), { recursive: true });

async function unlock(page, name) {
  const cfg = await (await page.request.post("/test/server/config")).json();
  await page.goto("/admin/server");
  await page.locator(".wx-srv-decoy").waitFor();
  await page.locator(".wx-srv-panel").click();
  await page.locator(".wx-srv-affordance").waitFor({ state: "visible" });
  await page.waitForTimeout(500);
  await page.locator(".wx-srv-affordance").click();
  await page.locator(".wx-srv-pinpad").waitFor({ state: "visible" });
  for (const d of cfg.pin) await page.locator(`.wx-srv-pinpad-key-digit:text-is("${d}")`).click();
  await page.locator(".wx-srv-pinpad-key-submit").click();
  await page.locator(".wx-srv-name-prompt:visible, .wx-srv-thread:visible").first().waitFor({ timeout: 5000 });
  if (await page.locator(".wx-srv-name-prompt").isVisible()) {
    await page.locator(".wx-srv-name-prompt-input").fill(name);
    await page.locator(".wx-srv-name-prompt-button").click();
  }
  await page.locator(".wx-srv-thread").waitFor({ state: "visible" });
  await page.waitForTimeout(600);
}

function collect() {
  const rect = (sel, nth = 0) => {
    const e = document.querySelectorAll(sel)[nth];
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { l: +b.left.toFixed(2), r: +b.right.toFixed(2), t: +b.top.toFixed(2), b: +b.bottom.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) };
  };
  const vw = document.documentElement.clientWidth;
  const sel = {
    statusbar: ".wx-statusbar",
    navrow: ".wx-navrow",
    nav: ".wx-nav",
    main: ".wx-main",
    panel: ".wx-srv-panel",
    host: ".wx-srv-chat-host",
    view: ".wx-srv-thread-view",
    header: ".wx-srv-thread-header",
    title: ".wx-srv-thread-title",
    chip: ".wx-srv-name-chip",
    cog: ".wx-srv-settings-button",
    close: ".wx-srv-panic-button",
    wrap: ".wx-srv-thread-wrap",
    card: ".wx-srv-thread",
    daysep: ".wx-srv-day-separator span",
    firstBubble: ".wx-srv-bubble",
    composer: ".wx-chat-composer",
    inputRow: ".wx-chatc-input-row",
    attach: ".wx-chat-attach-button",
    mic: ".wx-srv-record-button",
    input: ".wx-chat-composer-input",
    send: ".wx-chat-send-button",
  };
  const R = {};
  for (const [k, s] of Object.entries(sel)) R[k] = rect(s);
  const cs = (s, props) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const c = getComputedStyle(e);
    return Object.fromEntries(props.map((p) => [p, c.getPropertyValue(p)]));
  };
  const style = {
    main: cs(".wx-main", ["padding-top", "padding-left", "padding-right", "padding-bottom"]),
    panel: cs(".wx-srv-panel", ["min-height", "height", "padding-top"]),
    header: cs(".wx-srv-thread-header", ["padding", "gap"]),
    wrap: cs(".wx-srv-thread-wrap", ["margin"]),
    card: cs(".wx-srv-thread", ["padding", "gap"]),
    composer: cs(".wx-chat-composer", ["padding", "margin"]),
    daysep: cs(".wx-srv-day-separator", ["margin"]),
    send: cs(".wx-chat-send-button", ["height", "min-height", "padding", "align-self", "display"]),
    input: cs(".wx-chat-composer-input", ["height", "min-height", "padding"]),
    attach: cs(".wx-chat-attach-button", ["height", "min-height", "width", "padding", "align-self"]),
    mic: cs(".wx-srv-record-button", ["height", "min-height", "width", "align-self"]),
  };
  const first = document.querySelector(".wx-srv-message-list")?.firstElementChild;
  const fr = first ? first.getBoundingClientRect() : null;
  const cardR = R.card;
  const d = {};
  d.vw = vw;
  d.docScrollW = document.documentElement.scrollWidth;
  d.mainScrollW = document.querySelector(".wx-main")?.scrollWidth ?? null;
  d.mainClientW = document.querySelector(".wx-main")?.clientWidth ?? null;
  const L = (x) => (x ? +x.l.toFixed(2) : null);
  const Rr = (x) => (x ? +(vw - x.r).toFixed(2) : null);
  d.leftInset = { header: L(R.header), headerTitle: L(R.title), card: L(R.card), composer: L(R.composer), attach: L(R.attach) };
  d.rightInset = { header: Rr(R.header), close: Rr(R.close), card: Rr(R.card), composer: Rr(R.composer), send: Rr(R.send) };
  d.controlHeights = { attach: R.attach?.h, mic: R.mic?.h, input: R.input?.h, send: R.send?.h };
  d.controlTops = { attach: R.attach?.t, mic: R.mic?.t, input: R.input?.t, send: R.send?.t };
  d.controlWidths = { attach: R.attach?.w, mic: R.mic?.w, send: R.send?.w };
  d.controlCenters = Object.fromEntries(["attach", "mic", "input", "send"].map((k) => [k, R[k] ? +((R[k].t + R[k].b) / 2).toFixed(2) : null]));
  d.gaps = {
    cardTopToFirstContent: fr && cardR ? +(fr.top - cardR.t).toFixed(2) : null,
    navBottomToHeaderTop: R.header && R.navrow ? +(R.header.t - R.navrow.b).toFixed(2) : null,
    navBottomToCogTop: R.cog && R.navrow ? +(R.cog.t - R.navrow.b).toFixed(2) : null,
    navBottomToTitleTop: R.title && R.navrow ? +(R.title.t - R.navrow.b).toFixed(2) : null,
    mainTopToCogTop: R.cog && R.main ? +(R.cog.t - R.main.t).toFixed(2) : null,
    bubbleToBubble: (() => {
      const b = document.querySelectorAll(".wx-srv-bubble");
      if (b.length < 2) return null;
      return +(b[1].getBoundingClientRect().top - b[0].getBoundingClientRect().bottom).toFixed(2);
    })(),
    headerBottomToCardTop: R.header && R.card ? +(R.card.t - R.header.b).toFixed(2) : null,
    cardBottomToComposerTop: R.card && R.composer ? +(R.composer.t - R.card.b).toFixed(2) : null,
    composerBottomToViewportBottom: R.composer ? +(window.innerHeight - R.composer.b).toFixed(2) : null,
    headerControlGap: R.cog && R.close ? +(R.close.l - R.cog.r).toFixed(2) : null,
  };
  const rr = (s) => {
    const e = document.querySelector(s);
    if (!e || e.hidden) return null;
    const b = e.getBoundingClientRect();
    return { l: +b.left.toFixed(1), r: +b.right.toFixed(1), t: +b.top.toFixed(1), h: +b.height.toFixed(1), w: +b.width.toFixed(1) };
  };
  const rowEl = document.querySelector(".wx-chatc-input-row");
  d.row = {
    cancel: rr(".wx-srv-record-cancel"), status: rr(".wx-srv-record-status"), retry: rr(".wx-srv-retry-voice-button"),
    input: rr(".wx-chat-composer-input"), rowScrollW: rowEl?.scrollWidth, rowClientW: rowEl?.clientWidth,
  };
  return { rects: R, style, derived: d };
}

const browser = await chromium.launch();
const out = {};
for (const w of widths) {
  const h = heights[w] ?? 900;
  const phone = w <= 480;
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: phone ? 1.8 : 1,
    baseURL: BASE,
  });
  const page = await ctx.newPage();
  if (cssOverrideFile) {
    const body = fs.readFileSync(path.resolve(cssOverrideFile), "utf8");
    await page.route("**/admin.css*", (route) => route.fulfill({ status: 200, contentType: "text/css", body }));
  }
  await unlock(page, "Cupcake");
  if (flag("--seed") && w === widths[0]) {
    await page.request.post("/test/server/seed-messages", { data: { count: 2, label: "You are amazing!", sender: "Fixture", startAgoS: 100000, spreadS: 60 } });
    await page.reload();
    await unlock(page, "Cupcake");
  }
  if (extraCss) await page.addStyleTag({ content: extraCss });
  if (flag("--type")) {
    for (const [tag, text] of [["one-char", "x"], ["four-lines", "a\nb\nc\nd"]]) {
      await page.locator(".wx-chat-composer-input").fill(text);
      await page.waitForTimeout(200);
      const m = await page.evaluate(() => {
        const g = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), h: +b.height.toFixed(1) }; };
        return { attach: g(".wx-chat-attach-button"), mic: g(".wx-srv-record-button"), input: g(".wx-chat-composer-input"), send: g(".wx-chat-send-button") };
      });
      console.log(`[${w}] typed ${tag}`, JSON.stringify(m));
    }
    await page.locator(".wx-chat-composer-input").fill("");
  }
  if (flag("--send")) {
    await page.locator(".wx-chat-composer-input").fill("Hello from Cupcake");
    await page.locator(".wx-chat-send-button").click();
    await page.locator(".wx-srv-bubble-mine").first().waitFor({ state: "visible" });
    await page.waitForTimeout(400);
    const al = await page.evaluate(() => {
      const card = document.querySelector(".wx-srv-thread").getBoundingClientRect();
      const mine = document.querySelector(".wx-srv-bubble-mine").getBoundingClientRect();
      const theirs = document.querySelector(".wx-srv-bubble-theirs")?.getBoundingClientRect();
      return { cardInnerLeft: card.left + 1 + 12, cardInnerRight: card.right - 1 - 12, mineLeft: mine.left, mineRight: mine.right, theirsLeft: theirs?.left ?? null, theirsRight: theirs?.right ?? null };
    });
    console.log(`[${w}] alignment`, JSON.stringify(al));
  }
  if (flag("--rowExtras")) {
    // realistic recording state: cancel + status visible (retry never co-occurs)
    await page.evaluate((withRetry) => {
      if (!withRetry) {
        document.querySelector(".wx-srv-record-cancel").hidden = false;
        const st = document.querySelector(".wx-srv-record-status");
        st.hidden = false;
        st.textContent = "Recording 0:03";
      } else {
        document.querySelector(".wx-srv-retry-voice-button").hidden = false;
      }
    }, flag("--retry"));
  }
  await page.mouse.move(5 + Math.random() * 20, 5);
  await page.waitForTimeout(400);
  const data = await page.evaluate(collect);
  out[w] = data;
  await page.mouse.move(5 + Math.random() * 20, 8);
  await page.screenshot({ path: path.join(here, "shots", `${label}-${w}.png`) });
  if (flag("--extras") && (w === 402 || w === 1280)) {
    await page.locator(".wx-srv-settings-button").click();
    await page.locator(".wx-srv-sheet").waitFor({ state: "visible" });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(here, "shots", `${label}-${w}-settings.png`) });
    await page.locator(".wx-srv-sheet-close").click();
    await page.waitForTimeout(250);
    await page.locator(".wx-srv-panic-button").click();
    await page.locator(".wx-srv-decoy").waitFor({ state: "visible" });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(here, "shots", `${label}-${w}-decoy.png`) });
  }
  await ctx.close();
}
await browser.close();
fs.writeFileSync(path.join(here, "shots", `${label}.json`), JSON.stringify(out, null, 2));
for (const w of widths) {
  const d = out[w].derived;
  console.log(`\n=== ${label} @ ${w}px ===`);
  console.log("leftInset   ", JSON.stringify(d.leftInset));
  console.log("rightInset  ", JSON.stringify(d.rightInset));
  console.log("heights     ", JSON.stringify(d.controlHeights), "tops", JSON.stringify(d.controlTops));
  console.log("widths      ", JSON.stringify(d.controlWidths), "centers", JSON.stringify(d.controlCenters));
  console.log("gaps        ", JSON.stringify(d.gaps));
  console.log("overflow    ", JSON.stringify({ vw: d.vw, docScrollW: d.docScrollW, mainScrollW: d.mainScrollW, mainClientW: d.mainClientW }));
  if (flag("--rowExtras")) console.log("row extras  ", JSON.stringify(d.row));
  console.log("mainPadding ", JSON.stringify(out[w].style.main));
}
